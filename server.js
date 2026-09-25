require('dotenv').config();
const express = require('express');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const userSessions = new Map();

app.get('/', (req, res) => {
    res.status(200).send('🤖 Twilio WhatsApp ATS Bot is running 24/7!');
});

app.post('/webhook', async (req, res) => {
    const incomingMsg = req.body.Body ? req.body.Body.trim() : '';
    const senderID = req.body.From;
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    
    let session = userSessions.get(senderID) || { step: 'WAITING_FOR_RESUME' };
    const twiml = new twilio.twiml.MessagingResponse();

    try {
        if (numMedia > 0 && (session.step === 'WAITING_FOR_RESUME' || session.step === 'CHOICE_MENU')) {
            const mediaUrl = req.body.MediaUrl0;
            const contentType = req.body.MediaContentType0 || '';

            const response = await axios.get(mediaUrl, {
                responseType: 'arraybuffer',
                auth: {
                    username: process.env.TWILIO_ACCOUNT_SID,
                    password: process.env.TWILIO_AUTH_TOKEN
                }
            });

            const buffer = Buffer.from(response.data);
            let extractedText = '';

            if (contentType.includes('wordprocessingml') || mediaUrl.endsWith('.docx')) {
                const result = await mammoth.extractRawText({ buffer });
                extractedText = result.value;
            } else {
                const parsedPdf = await pdfParse(buffer);
                extractedText = parsedPdf.text;
            }

            if (!extractedText || extractedText.trim().length === 0) {
                twiml.message('⚠️ Could not extract text. Please upload a clear PDF or Word document.');
                res.writeHead(200, { 'Content-Type': 'text/xml' });
                return res.end(twiml.toString());
            }

            session.resumeText = extractedText;
            session.step = 'WAITING_FOR_JD';
            userSessions.set(senderID, session);

            twiml.message('📄 *Resume received successfully!*\n\nNow, please paste or send the *Job Description (JD)* you want to evaluate it against.');
        } 
        else if (session.step === 'WAITING_FOR_JD' || session.step === 'WAITING_FOR_NEW_JD') {
            if (!incomingMsg) {
                twiml.message('⚠️ Please send a valid text Job Description.');
                res.writeHead(200, { 'Content-Type': 'text/xml' });
                return res.end(twiml.toString());
            }

            session.jobDescription = incomingMsg;
            userSessions.set(senderID, session);

            const evaluationResult = await evaluateWithGemini(session.resumeText, session.jobDescription);

            session.step = 'CHOICE_MENU';
            userSessions.set(senderID, session);

            twiml.message(evaluationResult + "\n\n──────────────────\n🔄 *What would you like to do next?*\n\n1️⃣ Upload another resume (Send a new PDF/Word file)\n2️⃣ Change Job Description (Reply with *2*)");
        } 
        else if (session.step === 'CHOICE_MENU') {
            if (incomingMsg === '2') {
                session.step = 'WAITING_FOR_NEW_JD';
                userSessions.set(senderID, session);
                twiml.message('📝 Please paste the *new Job Description* you want to test:');
            } else {
                session.step = 'WAITING_FOR_RESUME';
                userSessions.set(senderID, session);
                twiml.message('👋 Please upload your resume as a *PDF or Word document* to get started.');
            }
        } 
        else {
            userSessions.set(senderID, { step: 'WAITING_FOR_RESUME' });
            twiml.message('👋 *Welcome to WhatsApp ATS Score Teller!*\n\nPlease upload your resume as a *PDF or Word document* to get started.');
        }

    } catch (error) {
        console.error("Webhook processing error details:", error);
        userSessions.delete(senderID);
        twiml.message(`❌ Error: ${error.message || 'An error occurred. Send any message to restart.'}`);
    }

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});

// Rigorous ATS Evaluation using gemini-3.1-flash-lite
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

app.listen(PORT, () => {
    console.log(`🚀 Twilio ATS Bot server running on port ${PORT}`);
});