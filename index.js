import 'dotenv/config';
import { StaticAuthProvider } from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import { ChatClient } from '@twurple/chat';
import axios from 'axios';
import { Pool } from 'pg';
import puppeteer from 'puppeteer';

const clientID = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const databaseUrl = process.env.DATABASE_URL;
const botAccessToken = process.env.BOT_ACCESS_TOKEN; // stream11bot access token
const botRefreshToken = process.env.BOT_REFRESH_TOKEN; // stream11bot refresh token
const streamerChannel = process.env.STREAMER_CHANNEL || 'notashleel'; // Default to notashleel

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

    const requiredScopes = ['chat:read', 'chat:edit'];
    const tokenScopes = validateResponse.data.scopes || [];
    if (!requiredScopes.every((scope) => tokenScopes.includes(scope))) {
      throw new Error(
        `Streamer token missing required scopes. Required: ${requiredScopes.join(', ')}. Found: ${tokenScopes.join(', ')}`,
      );
    }

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
    if (!user) {
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

          // Pin the message
          try {
            await botApiClient.chat.sendChatMessage({
              broadcasterId: userId,
              senderId: botUserId,
              message: `Hello @${user}!`,
            });
          } catch (pinError) {
            console.error('Error pinning message:', pinError.message, pinError);
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
      let isPollActive = false;
      try {
        client.query('SELECT isPollActive FROM channel WHERE channelid = $1', [apiClient.getUserByName(streamerChannel).id])
        if (result.rows.length > 0) {
          isPollActive = result.rows[0].isPollActive;
        }
        else {
          isPollActive = false;
          client.query('INSERT INTO channel (channelid, isPollActive) VALUES ($1, $2)', [apiClient.getUserByName(streamerChannel).id, isPollActive]);
        }

      } catch (error) {
        console.error('Error checking poll status:', error.message);
      }
      if (!isPollActive) {
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
          await videoPlayer.screenshot({
            path: `screenshots/stream11bot_${timestamp}.png`,
            type: 'png',
            fullPage: false,
          });
          console.log(`Screenshot saved: screenshots/stream11bot_${timestamp}.png`);
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
  }
}

// Run with the streamer's access token
main('1t7ayfa6cnmm2do1wcbdyiaiqkjogw', '2qzmpii24nl92xpmm46f25lhghrl7kti53rwbhp2gtfugj4z1e')

// runByCode('')