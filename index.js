import 'dotenv/config';
import { StaticAuthProvider } from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import { ChatClient } from '@twurple/chat';
import axios from 'axios';
import mongodb from 'mongodb';

const clientID = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const mongoURI = process.env.MONGO_URI;

const client = new mongodb.MongoClient(mongoURI);

async function runByCode(code) {
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

    // Call main with the new tokens
    await main(access_token, refresh_token);
  } catch (error) {
    console.error('Error exchanging code for tokens:', error.response?.data || error.message);
    throw error;
  }
}

async function main(accessToken, refreshToken) {
  try {
    // Validate the access token
    const validateResponse = await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: {
        Authorization: `OAuth ${accessToken}`,
      },
    });

    const requiredScopes = ['chat:read', 'chat:edit'];
    const tokenScopes = validateResponse.data.scopes || [];
    if (!requiredScopes.every((scope) => tokenScopes.includes(scope))) {
      throw new Error(
        `Token is missing required scopes. Required: ${requiredScopes.join(', ')}. Found: ${tokenScopes.join(', ')}`,
      );
    }

    const authProvider = new StaticAuthProvider(clientID, accessToken);

    const apiClient = new ApiClient({ authProvider });

    const userId = validateResponse.data.user_id;
    const user = await apiClient.users.getUserById(userId);
    if (!user) {
      throw new Error('Failed to fetch user data');
    }

    const chatClient = new ChatClient({
      authProvider,
      channels: [user.displayName],
    });

    await chatClient.connect();

    chatClient.onMessage(async (channel, user, text, msg) => {
      if (text === '!hi') {
        try {
          const broadcasterId = msg.channelId;
          
            chatClient.say(channel, `hello @${user}!`);
        } catch (error) {
          console.error('Error handling !hi command:', error);
          chatClient.say(channel, `@${user} Sorry, something went wrong while checking followage.`);
        }
      }


      // All the puppeteer code goes here for checking stream every 30 seconds

      // All the logic for creating polls goes here

      // Logic for ending polls and displaying results goes here

    });


    console.log(`Logged in as ${user.displayName} (${user.id})`);
  } catch (error) {
    console.error('Error in main:', error.message);
  } finally {
    if (client.isConnected()) {
      await client.close();
      console.log('MongoDB connection closed.');
    }
  }
}

// runByCode('ACCESS CODE').catch(console.error);

// main(process.env.ACCESS_TOKEN, process.env.REFRESH_TOKEN).catch(console.error);