import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const valorantUsername = process.env.VALORANT_USERNAME;
const valorantKey = process.env.VALORANT_KEY;
const [ username, tag ] = valorantUsername.split('#');
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
console.log('Data for last 10 matches:', dataForLast10Matches);