# Moose Crossing

A real-time multiplayer reaction game. Everyone drives down the same snowy Canadian highway on their own phone or laptop. **When the moose crosses, hit BRAKE first.** Brake for a beaver, a goose or a hockey player and you lose points.

- 2–8 players join with a 4-letter room code. No login, no install.
- Every screen stays in sync: the server puts the moose on everyone's road at the same moment.
- Fair timing: each device measures its own reaction time from when the moose appears on *that* screen, so a slow connection doesn't decide the winner.
- Round twists: Fog, Double Moose, Reverse (don't brake!), and a double-points Final.
- Room chat with Constable Moose, an announcer bot who roasts bad brakes.
- **Winner and loser:** highest total score after the final round wins a crown and a downloadable winner card. **Lowest total score loses**: the loser pays the stake (default **"Loser buys Timmies for everyone"**, which the host can change) and does a funny forfeit. Players tied for last split the stake; if everyone ties, nobody pays.
- Drop your connection? Reopen the page and you rejoin with your score.

## Run it locally

```bash
npm install
npm start
# open http://localhost:3000 in two browser windows (or on your phone on the same Wi-Fi)
```

Automated playtest (3 bot players, full 5-round game at 4x speed):

```bash
npm test
```

## Put it online (free, about 10 minutes)

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Moose Crossing"
   git branch -M main
   git remote add origin https://github.com/<your-username>/moose-crossing.git
   git push -u origin main
   ```
2. **Deploy on Render** — go to [render.com](https://render.com), sign in with GitHub, then **New → Web Service** and pick the `moose-crossing` repo.
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
3. Click **Create Web Service**. When it says *Live*, your public link is shown at the top (like `https://moose-crossing.onrender.com`). Share that link — friends type the room code and play.

> Free Render services sleep after ~15 minutes with no visitors, and the first visit then takes up to a minute to wake. Open the link yourself a minute before a demo or judging.

Railway, Fly.io or any host that runs Node and supports WebSockets will also work — just run `npm start`.

## How it works

| Piece | What it does |
|---|---|
| `server.js` | Express + Socket.io. Owns rooms, the round schedule (what crosses the road and when), brake judging, scoring, chat and the announcer bot. |
| `public/index.html` | All screens: join, lobby, road + BRAKE, round results, winner. |
| `public/client.js` | Draws what the server sends, measures reaction time on the device, sends brakes and chat. |
| `public/style.css` | Mobile-first styles; on laptops the standings and chat sit beside the road. |

## Scoring

| Event | Points |
|---|---|
| 1st / 2nd / 3rd to brake for the moose | +100 / +60 / +30 (everyone after: +10) |
| Brake for a beaver, goose or hockey player | −50 |
| Brake when nothing is on the road | −25 |
| Brake in the Reverse round | −50 (everyone who held still: +50) |
| Final round | everything ×2 |
