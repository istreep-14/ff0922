# ff-slim

Your FantasyPros leagues, FantasyPros current-week and rest-of-season projections, and Draft Sharks current-week and rest-of-season rankings. One HTML file. No dependencies.

Projections come from the public FantasyPros ranking pages (`r2p_pts` on each board). Draft Sharks comes from its rankings table. Leagues come from MyPlaybook, which only needs the account email.

```sh
cp .env.example .env   # put your FantasyPros email in FP_EMAIL
npm run fetch          # leagues + both projection sources, then HTML
npm run serve          # http://localhost:4173
npm test
```

`fetch` writes `data/snapshot.json` and `dist/index.html`. League keys live in the snapshot, so `data/` stays untracked.

If MyPlaybook returns no leagues, the previous league list is kept. An empty reply is how a dead session looks, and it must not wipe the last good copy.
