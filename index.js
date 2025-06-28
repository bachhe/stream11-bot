import 'dotenv/config';
import { StaticAuthProvider } from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import { ChatClient } from '@twurple/chat';
import axios from 'axios';
import { Pool } from 'pg';
import puppeteer from 'puppeteer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import multer from 'multer';
import pkg from 'jsonschema';
const { Validator } = pkg;

const clientID = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const databaseUrl = process.env.DATABASE_URL;
const botAccessToken = process.env.BOT_ACCESS_TOKEN;
const botRefreshToken = process.env.BOT_REFRESH_TOKEN;

const pool = new Pool({ connectionString: databaseUrl });

async function runByCode(code, tokenType = 'streamer') {
  let client;
  try {
    // Exchange the authorization code for access and refresh tokens
    const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: clientID,
        client_secret: clientSecret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: 'https://stream11.vercel.app/twitchbot/redirect',
      },
    });

    const { access_token, refresh_token } = tokenResponse.data;
    console.log('Access Token:', access_token);
    console.log('Refresh Token:', refresh_token);

    // Validate the access token to get the user ID
    const validateResponse = await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: {
        Authorization: `OAuth ${access_token}`,
      },
    });
    const userId = validateResponse.data.user_id;

    // Store tokens in PostgreSQL
    client = await pool.connect();
    await client.query(`
      INSERT INTO accessTokens (userid, accesstoken, refreshtoken)
      VALUES ($1, $2, $3)
      ON CONFLICT (userid)
      DO UPDATE SET accesstoken = EXCLUDED.accesstoken, refreshtoken = EXCLUDED.refreshtoken
    `, [userId, access_token, refresh_token]);

    // Call main with the new tokens if for streamer
    if (tokenType === 'streamer') {
      await main(access_token, refresh_token);
    }
    return { access_token, refresh_token };
  } catch (error) {
    console.error('Error exchanging code for tokens:', error.response?.data || error.message);
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

async function main(accessToken, refreshToken) {
  let chatClient;
  let browser;
  let pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let client;
  client = await pool.connect();
  try {
    // Validate the streamer's access token
    const validateResponse = await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: {
        Authorization: `OAuth ${accessToken}`,
      },
    });

    console.log('Streamer access token validated successfully:', validateResponse.data);
    const streamerChannel = validateResponse.data.login;

    // Validate the stream11bot access token
    if (!botAccessToken) {
      throw new Error('BOT_ACCESS_TOKEN not set in .env');
    }
    const botValidateResponse = await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: {
        Authorization: `OAuth ${botAccessToken}`,
      },
    });

    const authProvider = new StaticAuthProvider(clientID, accessToken);
    const botAuthProvider = new StaticAuthProvider(clientID, botAccessToken);
    const apiClient = new ApiClient({ authProvider });
    const botApiClient = new ApiClient({ authProvider: botAuthProvider });

    const userId = validateResponse.data.user_id; // notashleel user ID
    const user = await apiClient.users.getUserById(userId);
    if (!user) {
      throw new Error('Failed to fetch user data');
    }

    const botUserId = botValidateResponse.data.user_id; // stream11bot user ID
    const botUser = await botApiClient.users.getUserById(botUserId);
    if (!botUser) {
      throw new Error('Failed to fetch bot user data');
    }

    // Check if stream11bot is already a moderator
    const moderators = await apiClient.moderation.getModerators(userId);
    const isBotModerator = moderators.data.some((mod) => mod.userId === botUserId);

    if (!isBotModerator) {
      console.log(`Adding stream11bot as moderator for ${streamerChannel}`);
      try {
        await apiClient.moderation.addModerator(userId, botUserId);
        console.log(`stream11bot successfully added as moderator`);
      } catch (error) {
        console.error('Error adding stream11bot as moderator:', error.message, error.response?.data);
        console.log('Please manually mod stream11bot by typing "/mod stream11bot" in the notashleel chat.');
      }
    } else {
      console.log(`stream11bot (${botUserId}) is already a moderator for ${streamerChannel}`);
    }

    // Use stream11bot for chat
    chatClient = new ChatClient({
      authProvider: botAuthProvider,
      channels: [streamerChannel],
    });

    await chatClient.connect();
    console.log(`ChatClient connected to channel: ${streamerChannel}`);

    // Rate limit handling
    let lastMessageTime = 0;
    const messageCooldown = 1500; // 1.5 seconds between messages

    // Debug: Log all incoming messages
    chatClient.onMessage(async (channel, user, text, msg) => {
      console.log(`Received message in ${channel} from ${user}: ${text}`);

      if (text.toLowerCase() === '!hi') {
        try {
          const now = Date.now();
          if (now - lastMessageTime < messageCooldown) {
            console.log('Rate limit: Waiting to send message');
            return;
          }
          console.log(`Attempting to send message to ${channel}: Hello @${user}!`);
          await chatClient.say(channel, `Hello @${user}!`);
          lastMessageTime = now;
          console.log(`Message sent successfully to ${channel}`);

          try {
            await botApiClient.chat.sendChatMessage({
              broadcasterId: userId,
              senderId: botUserId,
              message: `Hello @${user}!`,
            });
          } catch (sendError) {
            console.error('Error sending message:', sendError.message, sendError);
          }
        } catch (error) {
          console.error('Error in chatClient.say:', error.message, error);
          try {
            await chatClient.say(channel, `@${user} Sorry, something went wrong.`);
          } catch (innerError) {
            console.error('Error sending error message:', innerError.message, innerError);
          }
        }
      }
    });

    setInterval(async () => {
      let ispollactive = false;
      try {
        const client = await pool.connect();
        const result = await client.query('SELECT ispollactive FROM channel WHERE channelid = $1', [(await apiClient.users.getUserByName(streamerChannel)).id]);
        console.log(result.rows)
        if (result.rows.length > 0) {
          ispollactive = result.rows[0].ispollactive;
        }
        else {
          console.log(await apiClient.users.getUserByName(streamerChannel))
          await client.query('INSERT INTO channel (channelid, ispollactive) VALUES ($1, $2)', [(await apiClient.users.getUserByName(streamerChannel)).id, ispollactive]);
        }

      } catch (error) {
        console.error('Error checking poll status:', error.message);
      }
      if (!ispollactive) {
      let page;
      try {
        let browser = await puppeteer.launch({
          headless: true,
          ignoreHTTPSErrors: true,
        });
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 }); 
        await page.goto(`https://www.twitch.tv/${streamerChannel}`, { waitUntil: 'networkidle2' });

        // Hide the chat column
        await page.evaluate(() => {
          const chat = document.querySelector('.right-column, .chat-room');
          if (chat) chat.style.display = 'none';
        });

        // Wait for the video player to load
        await page.waitForSelector('.video-player, .persistent-player', { timeout: 10000 });

        const videoPlayer = await page.$('.video-player, .persistent-player');
        if (videoPlayer) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const screenshotBuffer = await videoPlayer.screenshot({
            type: 'png',
            encoding: 'base64',
            fullPage: false,
          });
          const imageBase64 = screenshotBuffer.toString('base64');
          const mimeType = 'image/png';
          console.log(`Screenshot captured as base64 (length: ${imageBase64.length})`);
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
          const upload = multer({ storage: multer.memoryStorage() });
          const responseSchema = {
            type: 'object',
            properties: {
              game: { type: 'string', enum: ['valorant', 'chess'] },
              isInMatch: { type: 'boolean' }
            },
            required: ['game', 'isInMatch'],
            additionalProperties: false
          };

          const validateResponse = (data) => {
            const validator = new Validator();
            const result = validator.validate(data, responseSchema);
            if (!result.valid) {
              throw new Error(`Invalid response format: ${result.errors.join(', ')}`);
            }
            return data;
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
        } else {
          console.error('Video player element not found');
        }

      } catch (error) {
        console.error('Error in Puppeteer screenshot:', error.message);
      } finally {
        if (page) {
          await page.close();
        }
        if (browser) {
          await browser.close();
        }
      }
    } else {

    }
    }, 10000);

    // Debug: Log connection and authentication events
    chatClient.onAuthenticationSuccess(() => {
      console.log('ChatClient authentication successful');
    });
    chatClient.onAuthenticationFailure((text, retryCount) => {
      console.error(`ChatClient authentication failed: ${text}, retry count: ${retryCount}`);
    });
    chatClient.onJoin((channel, user) => {
      console.log(`ChatClient joined channel: ${channel} as ${user}`);
    });
    chatClient.onMessageFailed((channel, reason) => {
      console.error(`Failed to send message to ${channel}: ${reason}`);
    });
    chatClient.onMessageRatelimit((channel, delay) => {
      console.error(`Rate limited in ${channel}, delayed by ${delay}ms`);
    });

    console.log(`Bot logged in as ${botValidateResponse.data.login} (${botValidateResponse.data.user_id}), joined channel: ${streamerChannel}`);
  } catch (error) {
    console.error('Error in main:', error.message, error.response?.data);
  } finally {
    if (chatClient?.isConnected) {
      await chatClient.quit();
      console.log('ChatClient disconnected.');
    }
    if (client) {
      client.release();
    }
  }
}

// Run with the streamer's access token
main('67sk1e2k576091azcqppeiemjc8djp', 'aififkkyj8vvkdjrs99qfeifh6sedq3to0b5g022le7eoyvr4a')

// runByCode('9y0d4xs6tof7qhbuhrtm6vro2vkvu0')