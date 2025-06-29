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

const clientID = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const databaseUrl = process.env.DATABASE_URL;
const botAccessToken = process.env.BOT_ACCESS_TOKEN;
const botRefreshToken = process.env.BOT_REFRESH_TOKEN;
const valorantUsername = process.env.VALORANT_USERNAME;
const chessUsername = process.env.CHESS_USERNAME;
const valorantKey = process.env.VALORANT_KEY;

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
        redirect_uri: 'https://stream11.vercel.app/api/auth/twitch/callback',
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
      const stream = await apiClient.streams.getStreamByUserName(streamerChannel);
      if (!stream) {
        console.log(`No active stream found for ${streamerChannel}`);
        return;
      }
      let ispollactive = false;
      try {
        const client = await pool.connect();
        let result = await client.query('SELECT ispollactive FROM channel WHERE channelid = $1', [(await apiClient.users.getUserByName(streamerChannel)).id]);
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
        await page.goto(`https://www.twitch.tv/${streamerChannel}`, { waitUntil: 'networkidle2' });



        await page.waitForSelector('video', { timeout: 10000 });

        const videoElement = await page.$('video');
        if (videoElement) {
          const videoRect = await videoElement.boundingBox();
          const { x,y,width,height } = videoRect;
          console.log(`Video element found at x: ${x}, y: ${y}, width: ${width}, height: ${height}`);
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const screenshotBuffer = await videoElement.screenshot({
            type: 'png',
            encoding: 'base64',
            clip: {
              x: x,
              y: y,
              width: width,
              height: height
            }
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

          let result = await model.generateContent([
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
          if (!responseData.isInMatch){
            console.log('No active match detected');
            return;
          }

          if (responseData.game === 'valorant') {
            console.log('Valorant match detected');
            await chatClient.say(streamerChannel, `Valorant match is active!`);
            // Logic to start a poll for Valorant
            // await client.query('UPDATE channel SET lastpollgame = $1, ispollactive = $2 WHERE channelid = $3', ['valorant', true, (await apiClient.users.getUserByName(streamerChannel)).id]);
            //splitting of valorant username and tag
            const [username, tag] = valorantUsername.split('#');

            let lifetimeHistoryApi = `https://api.henrikdev.xyz/valorant/v4/matches/ap/pc/${username}/${tag}?size=10`;

            const lifetimeHistoryResponse = await axios.get(lifetimeHistoryApi, {
                headers: {
                    'Authorization': `${valorantKey}`
                }
            });
            // console.log('Lifetime history response:', JSON.stringify(lifetimeHistoryResponse.data));
            const matches = JSON.parse(JSON.stringify(lifetimeHistoryResponse.data.data));
            let dataForLast10Matches = {
                kills: 0,
                deaths: 0,
                headshot: 0,
                bodyshot: 0,
                legshot: 0,
                ultimate: 0,
            }
            for (let i=0; i < matches.length; i++) {
                const match = matches[i];
                console.log(`Match ${i + 1}:`, match.metadata['match_id']);
                //find the player with the given username and tag
                const player = match.players.find(p => p.name === username && p.tag === tag);
                if (player) {
                    console.log(`Player found: ${player.name}#${player.tag}`);
                    dataForLast10Matches.kills += player.stats.kills;
                    dataForLast10Matches.deaths += player.stats.deaths;
                    dataForLast10Matches.headshot += player.stats.headshots;
                    dataForLast10Matches.bodyshot += player.stats.bodyshots;
                    dataForLast10Matches.legshot += player.stats.legshots;
                    dataForLast10Matches.ultimate += player['ability_casts'].ultimate;
                } else {
                    console.log(`Player ${username}#${tag} not found in match ${i + 1}`);
                }

            }
            dataForLast10Matches.kda = parseFloat((dataForLast10Matches.kills / Math.max(dataForLast10Matches.deaths, 1)).toFixed(2));
            dataForLast10Matches.killsPerGame = parseInt((dataForLast10Matches.kills /10).toFixed(2));
            dataForLast10Matches.deathsPerGame = parseInt((dataForLast10Matches.deaths /10).toFixed(2));
            dataForLast10Matches.ultimatePerGame = parseInt((dataForLast10Matches.ultimate /10).toFixed(2));
            dataForLast10Matches.headshotPerGame = parseInt((dataForLast10Matches.headshot /10).toFixed(2));
            dataForLast10Matches.bodyshotPerGame = parseInt((dataForLast10Matches.bodyshot /10).toFixed(2));
            dataForLast10Matches.legshotPerGame = parseInt((dataForLast10Matches.legshot /10).toFixed(2));

            let question_list = [
              `average_kd`,
              `win_loss`,
              `headshot`,
              `bodyshot`,
              `legshot`,
              `ultimate`
            ]

            //select a random question from the list
            const randomQuestion = question_list[Math.floor(Math.random() * question_list.length)];
            console.log(`Random question selected: ${randomQuestion}`);

            const questionMap = {
              average_kd: `Will @${streamerChannel} have more than ${dataForLast10Matches.kda} K/D ratio?`,
              win_loss: `Will @${streamerChannel} win this game?`,
              headshot: `Will @${streamerChannel} have more than ${dataForLast10Matches.headshotPerGame} headshots this game?`,
              bodyshot: `Will @${streamerChannel} have more than ${dataForLast10Matches.bodyshotPerGame} bodyshots this game?`,
              legshot: `Will @${streamerChannel} have more than ${dataForLast10Matches.legshotPerGame} legshots this game?`,
              ultimate: `Will @${streamerChannel} use his ultimate more than ${dataForLast10Matches.ultimatePerGame} times this game?`
            }
            console.log(dataForLast10Matches);

            // Start a poll with the selected question
            await chatClient.say(streamerChannel, `${questionMap[randomQuestion]} | Bet chatpoints with !yesbet <amount> or !nobet <amount>`);
            await chatClient.say(streamerChannel, '/pin');

          } else if (responseData.game === 'chess') {
            console.log('Chess match detected');
            await chatClient.say(streamerChannel, `Chess match is active!`);
            //logic to start a poll
          }
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
      // const client = await pool.connect();
      // let result = await client.query('SELECT lastpollgame FROM channel WHERE channelid = $1', [(await apiClient.users.getUserByName(streamerChannel)).id]);
      // if (result.rows.length > 0) {
      //   const lastPollGame = result.rows[0].lastpollgame;
      //   if (lastPollGame) {
      //     console.log(`Last poll game was: ${lastPollGame}`);
          
      //     let lastAPICall = {};
      //     result = await client.query('SELECT lastapicall FROM channel WHERE channelid = $1', [(await apiClient.users.getUserByName(streamerChannel)).id]);
      //     if (result.rows.length > 0) {
      //       lastAPICall = JSON.parse(result.rows[0].lastapicall);
      //     }

      //     if (lastPollGame === 'valorant') {
      //       console.log('Valorant poll is still active');

      //       //checking for update in valorant api
      //     }

      //     if (lastPollGame === 'chess') {
      //       console.log('Chess poll is still active');
      //       //checking for update in chess api
      //     }

      //   } else {
      //     console.log('No last poll game found');
      //     await client.query('UPDATE channel SET lastpollgame = $1, ispollactive = $2 WHERE channelid = $3', ['none', false, (await apiClient.users.getUserByName(streamerChannel)).id]);
      //   }
      }

    }
    , 30000);

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
main('k8xsuolh5z7btdgy59wkvkw4vxkv4m', 'ks9gngke9dzzoti1741nc9zbitqi25ui0lnaybdt3xtkji3xx5')

// runByCode('lxostsvdxfgegbept6858tmy3rmprt')