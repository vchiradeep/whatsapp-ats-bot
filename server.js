require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MessagingResponse } = require('twilio').twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const userSessions = new Map();

app.post('/webhook', async (req, res) => {
    console.log("🔔 Incoming request from WhatsApp:", req.body);
    
    const senderID = req.body.From; 
    const incomingText = req.body.Body ? req.body.Body.trim() : '';
    const mediaUrl = req.body.MediaUrl0; 
    const mediaContentType = req.body.MediaContentType0 || '';

    let session = userSessions.get(senderID) || { step: 'WAITING_FOR_RESUME' };
    const twiml = new MessagingResponse();

    try {
        // Step 1: User sends a resume (PDF or Word Document)
        if (mediaUrl && (session.step === 'WAITING_FOR_RESUME' || session.step === 'CHOICE_MENU')) {
            const fileResponse = await axios.get(mediaUrl, {
                responseType: 'arraybuffer',
                auth: {
                    username: process.env.TWILIO_ACCOUNT_SID,
                    password: process.env.TWILIO_AUTH_TOKEN
                }
            });

            let extractedText = '';
            if (mediaContentType.includes('wordprocessingml') || mediaUrl.endsWith('.docx')) {
                const result = await mammoth.extractRawText({ buffer: fileResponse.data });
                extractedText = result.value;
            } else {
                const parsedPdf = await pdfParse(fileResponse.data);
                extractedText = parsedPdf.text;
            }

            if (!extractedText || extractedText.trim().length === 0) {
                twiml.message("⚠️ Could not extract text from this file. Please upload a clear PDF or Word document.");
                res.type('text/xml');
                return res.send(twiml.toString());
            }

            session.resumeText = extractedText;
            session.step = 'WAITING_FOR_JD';
            userSessions.set(senderID, session);

            twiml.message("📄 *Resume received successfully!*\n\nNow, please paste or send the *Job Description (JD)* you want to match it against.");
        } 
        // Step 2: User sends the Job Description (Initial or New JD)
        else if (session.step === 'WAITING_FOR_JD' || session.step === 'WAITING_FOR_NEW_JD') {
            if (!incomingText) {
                twiml.message("⚠️ Please send a valid text Job Description.");
            } else {
                session.jobDescription = incomingText;
                
                // If they came from option 2 (Change JD), use existing resume, otherwise save session
                userSessions.set(senderID, session);

                twiml.message("⏳ *Analyzing your resume against the Job Description... Please wait.*");

                // Call Gemini AI
                const evaluationResult = await evaluateWithGemini(session.resumeText, session.jobDescription);

                // Move to Choice Menu state
                session.step = 'CHOICE_MENU';
                userSessions.set(senderID, session);

                twiml.message(evaluationResult + "\n\n──────────────────\n🔄 *What would you like to do next?*\n\n1️⃣ Upload another resume (Send a new PDF/Word file)\n2️⃣ Change Job Description (Reply with *2*)");
            }
        } 
        // Step 3: Handling Choice Menu Options
        else if (session.step === 'CHOICE_MENU') {
            if (incomingText === '2') {
                session.step = 'WAITING_FOR_NEW_JD';
                userSessions.set(senderID, session);
                twiml.message("📝 Please paste the *new Job Description* you want to test:");
            } else {
                // Default fallback if they text something else
                session.step = 'WAITING_FOR_RESUME';
                userSessions.set(senderID, session);
                twiml.message("👋 Please upload your resume as a *PDF or Word document* to get started.");
            }
        } 
        // Default / Reset State
        else {
            userSessions.set(senderID, { step: 'WAITING_FOR_RESUME' });
            twiml.message("👋 *Welcome to WhatsApp ATS Score Teller!*\n\nPlease upload your resume as a *PDF or Word document* to get started.");
        }

        res.type('text/xml');
        res.send(twiml.toString());

    } catch (error) {
        console.error("Error processing webhook:", error);
        userSessions.delete(senderID);
        
        const errorTwiml = new MessagingResponse();
        errorTwiml.message("❌ An error occurred while processing your request. Please send 'hi' to restart.");
        res.type('text/xml');
        res.send(errorTwiml.toString());
    }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));