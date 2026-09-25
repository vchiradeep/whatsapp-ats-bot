require('dotenv').config();
const express = require('express');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

// 1. Express server to satisfy Render's web service health check
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.status(200).send('🤖 WhatsApp ATS Bot (Baileys) is running 24/7!');
});

app.listen(PORT, () => {
    console.log(`🚀 Express server running on port ${PORT}`);
});

// 2. Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const userSessions = new Map();

// 3. Start Baileys WhatsApp Connection
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), // Hide noisy logs
        printQRInTerminal: true // Prints QR code in your Render logs for initial linking
    });

    sock.льнай = sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp bot successfully connected and online!');
        }
    });

    // Handle Incoming Messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderID = msg.key.remoteJid; // e.g., '919032980320@s.whatsapp.net'
        
        // Extract message text or caption if it's a file
        const incomingText = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.documentMessage?.caption || '';
        
        const trimmedText = incomingText.trim();
        let session = userSessions.get(senderID) || { step: 'WAITING_FOR_RESUME' };

        try {
            // Check if user sent a document (PDF or Word)
            const documentMessage = msg.message.documentMessage;

            if (documentMessage && (session.step === 'WAITING_FOR_RESUME' || session.step === 'CHOICE_MENU')) {
                await sock.sendMessage(senderID, { text: '⏳ Downloading and processing your resume...' });

                // Get media stream from Baileys
                const stream = await downloadMediaMessage(msg, 'stream', {}, { logger: pino({ level: 'silent' }) });
                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }

                let extractedText = '';
                const fileName = documentMessage.fileName || '';
                const mimeType = documentMessage.mimetype || '';

                if (mimeType.includes('wordprocessingml') || fileName.endsWith('.docx')) {
                    const result = await mammoth.extractRawText({ buffer });
                    extractedText = result.value;
                } else {
                    const parsedPdf = await pdfParse(buffer);
                    extractedText = parsedPdf.text;
                }

                if (!extractedText || extractedText.trim().length === 0) {
                    await sock.sendMessage(senderID, { text: '⚠️ Could not extract text. Please upload a clear PDF or Word document.' });
                    return;
                }

                session.resumeText = extractedText;
                session.step = 'WAITING_FOR_JD';
                userSessions.set(senderID, session);

                await sock.sendMessage(senderID, { text: '📄 *Resume received successfully!*\n\nNow, please paste or send the *Job Description (JD)* you want to match it against.' });
            } 
            // Handle Job Description Input
            else if (session.step === 'WAITING_FOR_JD' || session.step === 'WAITING_FOR_NEW_JD') {
                if (!trimmedText) {
                    await sock.sendMessage(senderID, { text: '⚠️ Please send a valid text Job Description.' });
                    return;
                }

                session.jobDescription = trimmedText;
                userSessions.set(senderID, session);

                await sock.sendMessage(senderID, { text: '⏳ *Analyzing your resume against the Job Description... Please wait.*' });

                const evaluationResult = await evaluateWithGemini(session.resumeText, session.jobDescription);

                session.step = 'CHOICE_MENU';
                userSessions.set(senderID, session);

                await sock.sendMessage(senderID, { 
                    text: evaluationResult + "\n\n──────────────────\n🔄 *What would you like to do next?*\n\n1️⃣ Upload another resume (Send a new PDF/Word file)\n2️⃣ Change Job Description (Reply with *2*)" 
                });
            } 
            // Handle Post-Score Menu
            else if (session.step === 'CHOICE_MENU') {
                if (trimmedText === '2') {
                    session.step = 'WAITING_FOR_NEW_JD';
                    userSessions.set(senderID, session);
                    await sock.sendMessage(senderID, { text: '📝 Please paste the *new Job Description* you want to test:' });
                } else {
                    session.step = 'WAITING_FOR_RESUME';
                    userSessions.set(senderID, session);
                    await sock.sendMessage(senderID, { text: '👋 Please upload your resume as a *PDF or Word document* to get started.' });
                }
            } 
            // Default / Welcome State (triggered by 'hi' or anything else)
            else {
                userSessions.set(senderID, { step: 'WAITING_FOR_RESUME' });
                await sock.sendMessage(senderID, { text: '👋 *Welcome to WhatsApp ATS Score Teller!*\n\nPlease upload your resume as a *PDF or Word document* to get started.' });
            }

        } catch (error) {
            console.error("Error processing message:", error);
            userSessions.delete(senderID);
            await sock.sendMessage(senderID, { text: '❌ An error occurred. Send anything to restart.' });
        }
    });
}

// Helper to download media in Baileys
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

// AI Scoring Function using gemini-3.1-flash-lite
async function evaluateWithGemini(resumeText, jobDescription) {
    const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

    const prompt = `
    You are an expert ATS (Applicant Tracking System) and hiring manager. 
    Analyze the following Resume against the Job Description.

    Provide your response in this exact format, optimized for WhatsApp readability:
    📊 *ATS Match Score:* [0-100]%
    
    ✅ *Key Strengths:*
    - [Point 1]
    - [Point 2]
    
    ❌ *Missing Keywords / Gaps:*
    - [Point 1]
    - [Point 2]
    
    💡 *Actionable Improvements:*
    - [Tip 1]
    - [Tip 2]

    Resume Text:
    ${resumeText}

    Job Description:
    ${jobDescription}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
}

connectToWhatsApp();