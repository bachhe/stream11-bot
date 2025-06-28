import 'dotenv/config';
import { StaticAuthProvider } from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import { ChatClient } from '@twurple/chat';
import axios from 'axios';
import mongodb from 'mongodb';
import puppeteer from 'puppeteer';


const clientID = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const mongoURI = process.env.MONGO_URI;
const botAccessToken = process.env.BOT_ACCESS_TOKEN; // stream11bot access token
const botRefreshToken = process.env.BOT_REFRESH_TOKEN; // stream11bot refresh token
const streamerChannel = process.env.STREAMER_CHANNEL || 'notashleel'; // Default to notashleel

const client = new mongodb.MongoClient(mongoURI);

async function refreshToken(refreshToken, tokenType = 'streamer') {
  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: clientID,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      },
    });
    const { access_token, refresh_token } = response.data;
    console.log(`New ${tokenType} Access Token:`, access_token);
    console.log(`New ${tokenType} Refresh Token:`, refresh_token);

    // Store new tokens in MongoDB
    await client.connect();
    const db = client.db('twitch');
    await db.collection('tokens').updateOne(
      { clientId: clientID, type: tokenType },
      { $set: { accessToken: access_token, refreshToken: refresh_token, updatedAt: new Date() } },
      { upsert: true }
    );
    return { access_token, refresh_token };
  } catch (error) {
    console.error(`Error refreshing ${tokenType} token:`, error.response?.data || error.message);
    throw error;
  } finally {
    return;
  }
}

async function runByCode(code, tokenType = 'streamer') {
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

    // Store tokens in MongoDB
    await client.connect();
    const db = client.db('twitch');
    await db.collection('tokens').updateOne(
      { clientId: clientID, type: tokenType },
      { $set: { accessToken: access_token, refreshToken: refresh_token, updatedAt: new Date() } },
      { upsert: true }
    );

    // Call main with the new tokens if for streamer
    if (tokenType === 'streamer') {
      await main(access_token, refresh_token);
    }
    return { access_token, refresh_token };
  } catch (error) {
    console.error('Error exchanging code for tokens:', error.response?.data || error.message);
    throw error;
  } finally {
    return;
  }
}

async function main(accessToken, refreshToken) {
  let chatClient;
  try {
    await client.connect();
    console.log('Connected to MongoDB');

    // Validate the streamer's access token
    const validateResponse = await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: {
        Authorization: `OAuth ${accessToken}`,
      },
    });

    const requiredScopes = ['chat:read', 'chat:edit', 'channel:manage:moderators'];
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

    const botRequiredScopes = ['chat:read', 'chat:edit', 'moderator:manage:chat_messages'];
    if (!botRequiredScopes.every((scope) => botValidateResponse.data.scopes.includes(scope))) {
      throw new Error(
        `Bot token missing required scopes. Required: ${botRequiredScopes.join(', ')}. Found: ${botValidateResponse.data.scopes.join(', ')}`,
      );
    }

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

    setInterval(() => {

    }, 10000)

    // Rate limit handling
    let lastMessageTime = 0;
    const messageCooldown = 1500; // 1.5 seconds between messages

    // Handle incoming messages
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
              replyToId: msg.id,
            });
            console.log(`Pinned message in ${channel}: Hello @${user}!`);
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
    // Attempt to refresh the streamer token if 401 Unauthorized
    if (error.response?.status === 401) {
      console.log('Attempting to refresh streamer token...');
      try {
        const { access_token, refresh_token } = await refreshToken(refreshToken, 'streamer');
        await main(access_token, refresh_token);
      } catch (refreshError) {
        console.error('Failed to refresh streamer token:', refreshError.message);
      }
    }
  } finally {
    if (chatClient?.isConnected) {
      await chatClient.quit();
      console.log('ChatClient disconnected.');
    }
    if (client.isConnected()) {
      await client.close();
      console.log('MongoDB connection closed.');
    }
  }
}


// runByCode('', 'streamer').catch(console.error);