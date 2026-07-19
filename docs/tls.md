# HTTPS / TLS (opt-in)

By default the portal is served over plain HTTP (nginx `:80` → uvicorn
`127.0.0.1:1983`). Potato OS targets a trusted LAN, so HTTP is the default — but
you can opt into HTTPS with a self-signed certificate.

## Enable it at install time

```bash
POTATO_TLS=1 ./bin/install_dev.sh
```

This:
1. generates a self-signed cert (`bin/gen_tls_cert.sh`) at
   `/opt/potato/state/tls/{cert.pem,key.pem}` (key `0600`), with SANs for
   `potato.local`, the device hostname, `localhost` and loopback;
2. installs the TLS nginx server block (`nginx/potato-tls.conf`): TLS on `443`
   and a `301` redirect from `:80` → `https://…`;
3. runs `nginx -t` and reloads.

The portal is then reachable at **`https://potato.local/`**. Plain HTTP keeps
working as a redirect to HTTPS.

## Trusting the self-signed certificate

Browsers show a "Not secure / certificate not trusted" warning for self-signed
certs. Options:

- **Accept once** — click through the warning (*Advanced → Proceed*). Simplest
  for personal use on a trusted LAN.
- **Trust it permanently** — copy the cert to your client and add it to the OS/
  browser trust store:
  ```bash
  scp <user>@potato.local:/opt/potato/state/tls/cert.pem potato.local.pem
  # macOS:   Keychain Access → import → mark "Always Trust"
  # Linux:   sudo cp potato.local.pem /usr/local/share/ca-certificates/potato.crt && sudo update-ca-certificates
  # Windows: certutil -addstore -user Root potato.local.pem
  ```

## Bring your own certificate

Prefer a real cert (e.g. from an internal CA)? Drop your files in place and
reload nginx — no reinstall needed:

```bash
sudo cp your-cert.pem /opt/potato/state/tls/cert.pem
sudo cp your-key.pem  /opt/potato/state/tls/key.pem
sudo chmod 600 /opt/potato/state/tls/key.pem
sudo nginx -t && sudo systemctl reload nginx
```

## Regenerate the self-signed cert

```bash
sudo POTATO_TLS_FORCE=1 /opt/potato/bin/gen_tls_cert.sh /opt/potato/state/tls <hostname>
sudo systemctl reload nginx
```

## Notes

- **Custom hostname / address:** if you reach the portal under a name other than
  `potato.local`, add it to `POTATO_ALLOWED_HOSTS` (the `Host` guard) and to the
  cert's SANs (regenerate with the right hostname).
- `X-Forwarded-Proto` is already passed through to the app, so same-origin CSRF
  and redirects behave correctly under HTTPS.
- This is opt-in and additive: without `POTATO_TLS=1` nothing changes.
