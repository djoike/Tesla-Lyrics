# Runbook: deploy to the Synology NAS

How to run the production stack (`deploy/docker-compose.nas.yml`) on the NAS, move over from the old single-container setup, update it and roll it back. Same pattern as Recipe, mikromagi.dk, SharedLogin and BudgetApp (their runbooks are in the sibling folders).

> When Claude walks the owner through this, it gives **one step at a time**.

Hostname used below: `lyrics.monsted.org`. If you pick another, change it in `.env` (`REDIRECT_URI`), the Spotify dashboard, the tunnel route, and `SITE_URL` in `deploy/deploy-nas.sh` and `deploy/nas-env.sh`.

## Why this setup

The app used to run as one `docker run` container with host port 5011 forwarded by the router (`http://ds.monsted.org:5011`). The router ports were closed after the recently disclosed vulnerabilities. Now the app has no host port at all: Cloudflare Tunnel (`cloudflared`, outbound only) is the only way in, and the site gets HTTPS. HTTPS also fixes two things: Spotify only accepts HTTPS redirect URIs (apart from loopback), and the Wake Lock API only works on a secure page.

Because the site is on the internet:

- `/login` and `/callback` need the PIN too. Without the PIN, anyone could wipe the Spotify tokens or link their own account.
- Wrong PINs are limited to 10 per client per 15 minutes (by `CF-Connecting-IP`).
- `PIN_CODE` and `COOKIE_SECRET` have no defaults in the compose file, so the stack won't start without them.
- The PIN cookie is `Secure` and `SameSite=Lax`.

## 1. GitHub: let Actions pull base images and publish the image

In `djoike/Tesla-Lyrics`: **Settings > Secrets and variables > Actions**, add the same two secrets the other projects use:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

Push, wait for **CI** to go green, then run **Actions > Release > Run workflow** on `master` (or run `npm run deploy:nas -- --prepare`, which waits for CI and starts the Release for you). The image is published as `ghcr.io/djoike/tesla-lyrics`, the same package the old workflow used. Pushing no longer publishes an image by itself.

## 2. Spotify: add the new redirect URI

[developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) > the app > **Settings > Edit > Redirect URIs**, add:

```
https://lyrics.monsted.org/callback
```

Keep the old URI until step 7 is done.

## 3. Cloudflare: a tunnel

**Networking > Tunnels > Create a tunnel**, type _Cloudflared_, name `tesla-lyrics`. Skip the install step; copy the **tunnel token** into the password manager. Add one published application route:

| Hostname             | Service           |
| -------------------- | ----------------- |
| `lyrics.monsted.org` | `http://app:5011` |

Don't touch the `ds.monsted.org` record: it points at the home IP and is what SSH on port 25 uses.

## 4. NAS: folders and files

From the repo folder on the Mac (asks for the NAS password, then the sudo password):

```sh
ssh -t -p 25 MortenMonsted@192.168.1.222 'sudo mkdir -p /volume1/docker/tesla-lyrics/compose && sudo chown MortenMonsted /volume1/docker/tesla-lyrics/compose'
```

If the NAS isn't logged in to ghcr.io yet (it is, for the other projects): `echo '<token with read:packages>' | sudo docker login ghcr.io -u djoike --password-stdin`.

Copy `deploy/docker-compose.nas.yml` (as `docker-compose.yml`) and `deploy/.env.example` (as `.env`, mode 600). `COPYFILE_DISABLE=1` keeps macOS from adding `._*` files.

```sh
COPYFILE_DISABLE=1 tar -C deploy -cf - docker-compose.nas.yml .env.example | ssh -p 25 MortenMonsted@192.168.1.222 'cd /volume1/docker/tesla-lyrics/compose && tar -xf - && mv docker-compose.nas.yml docker-compose.yml && mv .env.example .env && chmod 600 .env && ls -la'
```

## 5. Fill in `.env`

From the repo folder on the Mac:

```sh
npm run deploy:nas-env
```

It asks for `CLOUDFLARE_TUNNEL_TOKEN` (step 3), then optionally new `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and `PIN_CODE` (leave them empty to keep the old ones), then the NAS password. On the NAS it does the following:

- **Old values:** copies the Spotify, PIN, Genius, Brave, GitHub and Tessie values from the old setup's `/volume1/docker/tesla-lyrics/.env` into keys that are still empty.
- **Redirect URI:** sets `REDIRECT_URI=https://lyrics.monsted.org/callback` if it is empty.
- **Cookie secret:** generates a new `COOKIE_SECRET` if it is empty. The old one may have been the built-in default.

It never overwrites a value you didn't type. Run it again to change a typed value. It ends with `All values are set.` or a list of what is still empty. Optional keys may stay empty: `BRAVE_SEARCH_API_KEY`, `GITHUB_TOKEN`, `GENIUS_ACCESS_TOKEN`, and `TESSIE_*` together.

If it says it can't read the old `.env`, the file belongs to root. Fix that and run it again:

```sh
ssh -t -p 25 MortenMonsted@192.168.1.222 'sudo chown MortenMonsted /volume1/docker/tesla-lyrics/.env'
```

Save a copy of `.env` in 1Password.

## 6. Retire the old container, first start

In an interactive SSH session on the NAS (`ssh -p 25 MortenMonsted@192.168.1.222`):

```sh
sudo docker stop tesla-lyrics && sudo docker rm tesla-lyrics
cd /volume1/docker/tesla-lyrics/compose
sudo docker compose --profile tunnel up -d
sudo docker compose --profile tunnel ps -a
curl -s https://lyrics.monsted.org/api/health
```

`app` and `cloudflared` are `Up`, and `app` turns `(healthy)` within a minute. Health says `"status":"ok"` and the commit as `version`.

## 7. Link Spotify, update the car

The Spotify tokens live in the Docker volume `tesla-lyrics_tokens`, not in the old `tokens.json`, so link Spotify once:

1. Open `https://lyrics.monsted.org`, enter the PIN.
2. Open `https://lyrics.monsted.org/login` in the same browser and log in to Spotify. It returns to the main screen.
3. In the Tesla browser, open `https://lyrics.monsted.org` and bookmark it (it asks for the PIN once per browser). Passengers use `https://lyrics.monsted.org/remote`.

When it works: remove the old `http://ds.monsted.org:5011/callback` URI in the Spotify dashboard, and after a while delete `/volume1/docker/tesla-lyrics/.env` and `/volume1/docker/tesla-lyrics/tokens.json`. The router's 5011 forward stays off for good.

## Update

Push, then from the Mac:

```sh
npm run deploy:nas
```

[`deploy/deploy-nas.sh`](../../deploy/deploy-nas.sh) waits for CI on the newest pushed commit, reuses or starts a **Release**, then logs in to the NAS over SSH (asks for the password once), pulls and restarts, and waits until `https://lyrics.monsted.org/api/health` reports the commit. `--prepare` only does the GitHub part. Override defaults with `NAS_HOST`, `NAS_PORT`, `NAS_USER`, `NAS_DIR`, `SITE_URL`.

It uses the NAS's LAN address, so run it from the home network with SSH enabled in DSM, as for the other projects.

By hand, on the NAS:

```sh
cd /volume1/docker/tesla-lyrics/compose
sudo docker compose --profile tunnel pull
sudo docker compose --profile tunnel up -d
```

When `deploy/docker-compose.nas.yml` changed, copy it to the NAS first (`npm run deploy:nas` only pulls images):

```sh
COPYFILE_DISABLE=1 scp -O -P 25 deploy/docker-compose.nas.yml MortenMonsted@192.168.1.222:/volume1/docker/tesla-lyrics/compose/docker-compose.yml
```

## Rollback

Pin `IMAGE=ghcr.io/djoike/tesla-lyrics:sha-<short7>` in `.env` and run the update commands. There is no database, so nothing else to undo.

## Logs

```sh
sudo docker compose logs --tail 200 app
sudo docker compose logs cloudflared
```
