require('dotenv').config();
const express = require('express');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.status(200).send('🤖 WhatsApp ATS Bot (Baileys) is running 24/7!');
});

app.listen(PORT, () => {
    console.log(`🚀 Express server running on port ${PORT}`);
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const userSessions = new Map();

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    // If not registered, generate a Pairing Code using the environment variable
    if (!sock.authState.creds.registered) {
        const phoneNumber = process.env.BOT_PHONE_NUMBER;
        if (phoneNumber) {
            setTimeout(async () => {
                try {
                    console.log(`requesting pairing code for ${phoneNumber}...`);
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n========================================`);
                    console.log(`🔑 YOUR WHATSAPP PAIRING CODE IS: ${code}`);
                    console.log(`========================================\n`);
                } catch (err) {
                    console.error("Error getting pairing code:", err);
                }
            }, 5000); // Wait 5 seconds for socket connection to initialize
        } else {
            console.log("⚠️ BOT_PHONE_NUMBER environment variable is missing in Render!");
        }
    }

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

        const senderID = msg.key.remoteJid;
        const incomingText = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.documentMessage?.caption || '';
        
        const trimmedText = incomingText.trim();
        const documentMessage = msg.message.documentMessage;

        let session = userSessions.get(senderID);

        if (!session) {
            if (trimmedText.toLowerCase() === '!ats') {
                session = { step: 'WAITING_FOR_RESUME' };
                userSessions.set(senderID, session);
                await sock.sendMessage(senderID, { text: '🤖 *ATS Bot Activated!*\n\nPlease upload your resume as a *PDF or Word document* to get started.\n\n*(Type **!exit** anytime to quit)*' });
            }
            return; 
        }

        if (trimmedText.toLowerCase() === '!exit') {
            userSessions.delete(senderID);
            await sock.sendMessage(senderID, { text: '❌ ATS Bot session closed. Your personal chat is back to normal.' });
            return;
        }

        try {
            if (documentMessage && (session.step === 'WAITING_FOR_RESUME' || session.step === 'CHOICE_MENU')) {
                await sock.sendMessage(senderID, { text: '⏳ Downloading and analyzing your resume structure...' });

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

                await sock.sendMessage(senderID, { text: '📄 *Resume received successfully!*\n\nNow, please paste or send the *Job Description (JD)* you want to evaluate it against.' });
            } 
            else if (session.step === 'WAITING_FOR_JD' || session.step === 'WAITING_FOR_NEW_JD') {
                if (!trimmedText) {
                    await sock.sendMessage(senderID, { text: '⚠️ Please send a valid text Job Description.' });
                    return;
                }

                session.jobDescription = trimmedText;
                userSessions.set(senderID, session);

                await sock.sendMessage(senderID, { text: '⏳ *Running deep ATS keyword matching & gap analysis... Please wait.*' });

                const evaluationResult = await evaluateWithGemini(session.resumeText, session.jobDescription);

                session.step = 'CHOICE_MENU';
                userSessions.set(senderID, session);

                await sock.sendMessage(senderID, { 
                    text: evaluationResult + "\n\n──────────────────\n🔄 *What would you like to do next?*\n\n1️⃣ Upload another resume (Send a new PDF/Word file)\n2️⃣ Change Job Description (Reply with *2*)\n3️⃣ Exit Bot (Reply with *!exit*)" 
                });
            } 
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
            else {
                userSessions.set(senderID, { step: 'WAITING_FOR_RESUME' });
                await sock.sendMessage(senderID, { text: '🤖 Please upload your resume as a *PDF or Word document* to get started.' });
            }

        } catch (error) {
            console.error("Error processing message:", error);
            userSessions.delete(senderID);
            await sock.sendMessage(senderID, { text: '❌ An error occurred. Type *!ats* to restart the bot.' });
        }
    });
}

async function evaluateWithGemini(resumeText, jobDescription) {
    const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

    const prompt = `
    You are an elite, strict Applicant Tracking System (ATS) algorithm and a Senior Technical Hiring Manager. Conduct a deep, rigorous evaluation of the Resume against the Job Description.

    Provide a highly detailed, professional breakdown optimized for WhatsApp readability using this exact format:

    📊 *ATS Match Score:* [0-100]%
    
    🎯 *Core Alignment Summary:*
    - [1-2 sharp sentences analyzing why it earned this score and overall fit]

    ✅ *Key Matched Strengths:*
    - [Specific matched skill or tool found in the resume]
    - [Another strength demonstrating clear alignment with the role]
    - [Another matched domain knowledge or experience point]
    
    ❌ *Critical Gaps & Missing Keywords:*
    - [Specific technical skill, tool, framework, or qualification required by the JD that is missing from the resume]
    - [Specific missing experience or metric gap]
    
    💡 *High-Impact Actionable Improvements:*
    - [Concrete fix 1: Exactly what bullet point or section to add/modify]
    - [Concrete fix 2: Specific keyword placement recommendation to bypass automated filters]
    - [Concrete fix 3: Structural or formatting adjustment to raise the score]

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