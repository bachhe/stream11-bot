import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();
const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const screenshotPath = path.join(__dirname, 'testScreenshot1.png');
console.log(`Reading screenshot from: ${screenshotPath}`);
const screenshotBuffer = fs.readFileSync(screenshotPath);

const imageBase64 = screenshotBuffer.toString('base64');
const mimeType = 'image/png';
console.log(`Screenshot captured as base64 (length: ${imageBase64.length})`);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
const responseSchema = {
    type: 'object',
    properties: {
        game: { type: 'string', enum: ['valorant', 'chess'] },
        isInMatch: { type: 'boolean' }
        },
    required: ['game', 'isInMatch'],
    additionalProperties: false
};
const prompt = `
            Analyze the provided image to determine if it shows a game of Valorant or Chess (on Chess.com).
            For Valorant:
              - Return isInMatch: true if the image shows an active match (e.g., in-game UI with health bars, minimap, or kill feed visible).
              - Return isInMatch: false if the image shows the lobby, agent selection screen, or main menu.
            For Chess (on Chess.com):
              - Return isInMatch: true if the image shows an active match with both player timers visible and no checkmate indication.
              - Return isInMatch: false if the image shows the Chess.com homepage, analysis board, or a completed game (e.g., checkmate or draw).
            Return the result in the following JSON format:
            {
              "game": "valorant" | "chess",
              "isInMatch": boolean
            }
          `;

const result = await model.generateContent([
    prompt,
    {
        inlineData: {
            data: imageBase64,
            mimeType: mimeType
            }
        }
    ], {
        responseMimeType: 'application/json',
        responseSchema: responseSchema
  });

const responseData = JSON.parse(result.response.text().replace('```json', '').replace('```', ''));
console.log('Response from Gemini AI:', responseData);
