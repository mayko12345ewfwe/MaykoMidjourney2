require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Discord client setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Store pending jobs
const pendingJobs = new Map();

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ status: 'Bot is running!', uptime: process.uptime() });
});

// Endpoint do otrzymywania promptów z Make.com
app.post('/generate', async (req, res) => {
    try {
        const { prompt, webhook_url } = req.body;
        
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        const channel = client.channels.cache.get(process.env.CHANNEL_ID);
        if (!channel) {
            return res.status(500).json({ error: 'Channel not found' });
        }

        // Generuj unikalny job ID
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Zapisz job z webhook URL
        pendingJobs.set(jobId, {
            prompt,
            webhook_url: webhook_url || process.env.MAKE_WEBHOOK_URL,
            timestamp: Date.now(),
            status: 'pending'
        });

        // Wyślij prompt do Midjourney
        const message = await channel.send(`/imagine prompt:${prompt} --job-id ${jobId}`);
        
        console.log(`Job ${jobId} sent: ${prompt}`);
        
        res.json({ 
            success: true, 
            jobId, 
            message: 'Prompt sent to Midjourney',
            estimatedTime: '60-120 seconds'
        });

    } catch (error) {
        console.error('Error in /generate:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint do sprawdzania statusu
app.get('/status/:jobId', (req, res) => {
    const job = pendingJobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
});

// Discord event handlers
client.on('ready', () => {
    console.log(`Bot logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    // Sprawdź czy to wiadomość od Midjourney z obrazem
    if (message.author.id === '936929561302675456' && message.attachments.size > 0) {
        try {
            await processNewImage(message);
        } catch (error) {
            console.error('Error processing image:', error);
        }
    }
});

async function processNewImage(message) {
    const attachment = message.attachments.first();
    if (!attachment || !attachment.url.includes('.png')) return;

    // Sprawdź czy to finalna wersja (nie grid)
    if (message.content && message.content.includes('(Waiting to start)')) return;

    // Znajdź job ID w message content lub poprzednich wiadomościach
    let jobId = null;
    
    // Przeszukaj ostatnie wiadomości w kanale szukając job ID
    const messages = await message.channel.messages.fetch({ limit: 50 });
    for (const [, msg] of messages) {
        if (msg.content.includes('--job-id')) {
            const match = msg.content.match(/--job-id (job_\w+)/);
            if (match && pendingJobs.has(match[1])) {
                jobId = match[1];
                break;
            }
        }
    }

    if (!jobId) {
        console.log('No matching job found for image');
        return;
    }

    const job = pendingJobs.get(jobId);
    if (!job || job.status === 'completed') return;

    // Aktualizuj status job
    job.status = 'completed';
    job.imageUrl = attachment.url;
    job.completedAt = Date.now();

    console.log(`Job ${jobId} completed: ${attachment.url}`);

    // Wyślij do Make.com webhook
    if (job.webhook_url) {
        try {
            await axios.post(job.webhook_url, {
                jobId,
                prompt: job.prompt,
                imageUrl: attachment.url,
                status: 'completed',
                timestamp: new Date().toISOString()
            });
            console.log(`Webhook sent for job ${jobId}`);
        } catch (error) {
            console.error(`Webhook error for job ${jobId}:`, error.message);
        }
    }

    // Usuń job po 1 godzinie
    setTimeout(() => {
        pendingJobs.delete(jobId);
    }, 3600000);
}

// Cleanup old jobs (co 10 minut)
setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of pendingJobs.entries()) {
        if (now - job.timestamp > 1800000) { // 30 minut
            pendingJobs.delete(jobId);
            console.log(`Cleaned up old job: ${jobId}`);
        }
    }
}, 600000);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down...');
    client.destroy();
    process.exit(0);
});