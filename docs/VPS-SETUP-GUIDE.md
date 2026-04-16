# SMMTA-Next: VPS Test Deployment Guide

Complete step-by-step instructions to set up and test the SMMTA-Next application on a fresh VPS from scratch. Every command is explained.

---

## Table of Contents

1. [VPS Requirements](#1-vps-requirements)
2. [Initial Server Setup](#2-initial-server-setup)
3. [Install Node.js 22](#3-install-nodejs-22)
4. [Install Docker & Docker Compose](#4-install-docker--docker-compose)
5. [Get the Code onto the VPS](#5-get-the-code-onto-the-vps)
6. [Start PostgreSQL and Redis](#6-start-postgresql-and-redis)
7. [Install Dependencies](#7-install-dependencies)
8. [Configure Environment Variables](#8-configure-environment-variables)
9. [Push the Database Schema](#9-push-the-database-schema)
10. [Run the API in Development Mode](#10-run-the-api-in-development-mode)
11. [Verify the API is Working](#11-verify-the-api-is-working)
12. [Create a Test JWT Token](#12-create-a-test-jwt-token)
13. [Test the Full Flow](#13-test-the-full-flow-end-to-end)
14. [Run as a Production Service](#14-run-as-a-production-service)
15. [Set Up Nginx Reverse Proxy](#15-set-up-nginx-reverse-proxy)
16. [Firewall and Security](#16-firewall-and-security)
17. [Monitoring and Logs](#17-monitoring-and-logs)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. VPS Requirements

**Minimum specs:**
- Ubuntu 22.04 or 24.04 LTS (this guide assumes Ubuntu; adapt for other distros)
- 2 CPU cores
- 4 GB RAM (PostgreSQL + Node.js + Redis)
- 40 GB SSD storage
- SSH access with a sudo-capable user

**Recommended specs for production testing:**
- 4 CPU cores, 8 GB RAM, 80 GB SSD

**Providers that work well:** Hetzner, DigitalOcean, Linode, Vultr, AWS Lightsail. Any provider offering Ubuntu 22.04+ will work.

---

## 2. Initial Server Setup

Connect to your VPS via SSH:

```bash
ssh root@YOUR_VPS_IP
```

### 2.1 Create a non-root user

Running everything as root is a security risk. Create a dedicated user:

```bash
adduser smmta
```

You'll be prompted for a password — choose a strong one. You can skip the full name and other optional fields by pressing Enter.

Give this user sudo privileges:

```bash
usermod -aG sudo smmta
```

### 2.2 Switch to the new user

```bash
su - smmta
```

From now on, all commands run as this user. Commands that need root will use `sudo`.

### 2.3 Update the system

This ensures all packages are up to date and security patches are applied:

```bash
sudo apt update && sudo apt upgrade -y
```

### 2.4 Install essential tools

```bash
sudo apt install -y curl wget git build-essential
```

- `curl` and `wget`: for downloading files from URLs
- `git`: version control (needed to clone the repo or receive code)
- `build-essential`: C/C++ compiler tools — some npm packages have native addons that compile during install

---

## 3. Install Node.js 22

We use the NodeSource repository to get Node.js 22 (the LTS version the project requires).

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**What this does:**
- The first line downloads a setup script from NodeSource and runs it. It adds their APT repository to your system so that `apt install nodejs` installs Node.js 22 instead of the older version Ubuntu ships by default.
- The second line installs Node.js and npm together.

Verify the installation:

```bash
node --version    # Should show v22.x.x
npm --version     # Should show 10.x.x or 11.x.x
```

**Why Node 22?** The project's `package.json` specifies `"engines": { "node": ">=22.0.0" }`. Node 22 supports ES modules natively, which this project uses throughout.

---

## 4. Install Docker & Docker Compose

Docker runs PostgreSQL and Redis in isolated containers, so you don't need to install and configure them directly on the server.

### 4.1 Install Docker

```bash
# Add Docker's official GPG key and repository
sudo apt install -y ca-certificates gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

**What this does:**
- Adds Docker's official package repository (not the outdated one in Ubuntu's default repos)
- Installs the Docker engine, CLI, container runtime, and the Compose plugin

### 4.2 Allow your user to run Docker without sudo

```bash
sudo usermod -aG docker smmta
```

**Important:** Log out and back in for this to take effect:

```bash
exit
su - smmta
```

Verify Docker works:

```bash
docker --version          # Should show Docker version 24.x or 27.x
docker compose version    # Should show Docker Compose v2.x
```

---

## 5. Get the Code onto the VPS

You have two options:

### Option A: Clone from a Git repository (recommended)

If you've pushed the code to GitHub/GitLab:

```bash
cd ~
git clone https://github.com/YOUR_ORG/smmta-next.git
cd smmta-next
```

### Option B: Upload from your local machine via SCP

From your local Windows machine, open a terminal:

```bash
scp -r K:/smmta-next smmta@YOUR_VPS_IP:~/smmta-next
```

**What SCP does:** Securely copies files over SSH from your local machine to the VPS. The `-r` flag means recursive (copies all subdirectories).

Then on the VPS:

```bash
cd ~/smmta-next
```

**Important:** If uploading, do NOT copy `node_modules/` — it's large and platform-specific. We'll install fresh dependencies on the VPS. If you accidentally copied it:

```bash
rm -rf node_modules apps/api/node_modules apps/web/node_modules packages/shared-types/node_modules
```

---

## 6. Start PostgreSQL and Redis

The project includes a `docker-compose.yml` that defines both services. Start them:

```bash
cd ~/smmta-next
docker compose up -d
```

**Flags explained:**
- `up`: Create and start the containers
- `-d`: Detached mode — runs in the background so you get your terminal back

**What this starts:**
- **PostgreSQL 16** on port 5432 — the main database. Username: `smmta`, password: `smmta`, database: `smmta_next`
- **Redis 7** on port 6379 — used for the BullMQ task queue (async jobs like PDF generation)

Verify both containers are running:

```bash
docker compose ps
```

You should see two containers with status "Up". To check that PostgreSQL is accepting connections:

```bash
docker compose exec postgres pg_isready -U smmta -d smmta_next
```

Should print: `smmta_next - accepting connections`

**Where does the data live?** Docker stores PostgreSQL data in a named volume called `pgdata`. This survives container restarts but NOT `docker compose down -v` (the `-v` flag deletes volumes).

---

## 7. Install Dependencies

```bash
cd ~/smmta-next
npm install
```

**What this does:**
- Reads the root `package.json` and all workspace `package.json` files (`apps/api`, `apps/web`, `packages/shared-types`)
- Downloads all dependencies from the npm registry
- Links workspace packages together (so `@smmta/api` can import from `@smmta/shared-types`)
- Takes 1-3 minutes depending on network speed

You should see output ending with something like `added 228 packages`.

Then build the shared types package (other packages depend on it):

```bash
cd ~/smmta-next/packages/shared-types
npx tsc
cd ~/smmta-next
```

**Why build shared-types first?** The API code imports from `@smmta/shared-types`. TypeScript needs the compiled `.js` and `.d.ts` files to exist before the API can reference them.

---

## 8. Configure Environment Variables

The API reads its configuration from environment variables. Create the `.env` file:

```bash
nano ~/smmta-next/apps/api/.env
```

Paste this content (edit the values marked with ← CHANGE):

```env
# Server
PORT=3000
HOST=0.0.0.0
NODE_ENV=development

# Database (matches docker-compose.yml)
DATABASE_URL=postgresql://smmta:smmta@localhost:5432/smmta_next

# Auth - CHANGE THIS to a random string of at least 32 characters
JWT_SECRET=CHANGE_ME_to_a_random_string_at_least_32_chars_long

# Luca GL API - set to your Luca instance URL
# If Luca is not running yet, leave this as-is; GL postings will fail gracefully
LUCA_API_BASE_URL=http://localhost:4000
LUCA_API_TIMEOUT_MS=10000

# Redis (matches docker-compose.yml)
REDIS_URL=redis://localhost:6379
```

Save and exit: Press `Ctrl+X`, then `Y`, then `Enter`.

**What each variable does:**
- `PORT`: The port the API listens on. 3000 is standard for Node.js dev.
- `HOST`: `0.0.0.0` means listen on all network interfaces (needed for external access via Nginx).
- `DATABASE_URL`: PostgreSQL connection string. Must match the credentials in `docker-compose.yml`.
- `JWT_SECRET`: The signing key for JWT tokens. In production, use a long random string. Anyone who knows this secret can forge auth tokens.
- `LUCA_API_BASE_URL`: Where the Luca General Ledger API is running. If you're testing without Luca, GL-triggering operations will return errors but non-GL operations (basic CRUD) will work fine.
- `REDIS_URL`: Redis connection for the background task queue.

**To generate a random JWT secret:**

```bash
openssl rand -base64 48
```

Copy the output and paste it as the `JWT_SECRET` value.

---

## 9. Push the Database Schema

This creates all 35+ tables in PostgreSQL:

```bash
cd ~/smmta-next/apps/api
npx drizzle-kit push
```

**What `drizzle-kit push` does:**
- Reads the Drizzle schema files (`src/db/schema/*.ts`)
- Connects to PostgreSQL using the `DATABASE_URL` from your `.env`
- Creates all tables, columns, indexes, enums, and foreign keys
- This is a "push" operation — it modifies the database to match your schema directly, without generating migration SQL files

You'll see output listing each table being created. If it asks for confirmation, type `y`.

**Verify the tables were created:**

```bash
docker compose exec postgres psql -U smmta -d smmta_next -c "\dt"
```

This runs a `psql` command inside the PostgreSQL container. `\dt` lists all tables. You should see approximately 35 tables.

---

## 10. Run the API in Development Mode

```bash
cd ~/smmta-next/apps/api
npx tsx src/server.ts
```

**What `tsx` does:** It's a TypeScript executor — it compiles and runs `.ts` files directly without a separate build step. In development this is convenient because you get instant feedback.

You should see:

```
SMMTA-Next API running at http://0.0.0.0:3000
API docs at http://0.0.0.0:3000/docs
```

**Leave this running** in the terminal. Open a new SSH session for the next steps:

```bash
ssh smmta@YOUR_VPS_IP
```

---

## 11. Verify the API is Working

### 11.1 Health check

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{"status":"ok","timestamp":"2026-04-12T...","version":"0.1.0"}
```

This confirms:
- Node.js is running
- Fastify is handling requests
- The server is listening on port 3000

### 11.2 Check Swagger docs

```bash
curl -s http://localhost:3000/docs/json | head -20
```

This returns the OpenAPI 3.1 spec. If you've set up Nginx (step 15), you can view the interactive docs in a browser at `http://YOUR_VPS_IP/docs`.

---

## 12. Create a Test JWT Token

Every API endpoint (except `/health`) requires a JWT token. For testing, we'll create one manually.

Create a small script:

```bash
cat > ~/generate-token.mjs << 'EOF'
import jwt from 'jsonwebtoken';

// MUST match the JWT_SECRET in your .env file
const secret = process.argv[2] || 'dev-secret-change-in-production';

const payload = {
  userId: '00000000-0000-0000-0000-000000000001',
  companyId: '00000000-0000-0000-0000-000000000099',
  email: 'test@example.com',
  roles: ['admin'],
};

const token = jwt.sign(payload, secret, { expiresIn: '7d' });
console.log(token);
EOF
```

Install the JWT library and run it:

```bash
cd ~/smmta-next
npm install jsonwebtoken
node ~/generate-token.mjs "YOUR_JWT_SECRET_HERE"
```

**Replace `YOUR_JWT_SECRET_HERE`** with the exact same value you put in `.env`.

This prints a JWT token string. Save it:

```bash
export TOKEN="paste_the_token_here"
```

**What this token contains:**
- `userId`: A fake UUID identifying the test user
- `companyId`: A fake UUID identifying the test company. All data is scoped to this company ID (multi-tenancy).
- `roles`: `['admin']` — full access
- `expiresIn: '7d'`: Token is valid for 7 days

**Why do we need this?** The API uses JWT-based authentication. Every request must include an `Authorization: Bearer <token>` header. The API decodes the token to determine which company's data to return.

---

## 13. Test the Full Flow (End-to-End)

This walks through a complete business cycle: create a product → add stock → create a customer → create an order → allocate stock → invoice the order. Each step builds on the previous one.

### 13.1 Create a warehouse

```bash
curl -s -X POST http://localhost:3000/api/v1/warehouses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Main Warehouse", "isDefault": true}' | jq .
```

**What `jq .` does:** Pretty-prints the JSON response. Install it with `sudo apt install -y jq` if you don't have it.

Save the warehouse ID from the response:

```bash
export WAREHOUSE_ID="paste_the_id_from_response"
```

### 13.2 Create a product

```bash
curl -s -X POST http://localhost:3000/api/v1/products \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Widget Pro X1",
    "stockCode": "WPX1",
    "expectedNextCost": 12.50,
    "minSellingPrice": 25.00,
    "productType": "PHYSICAL",
    "requireSerialNumber": false
  }' | jq .
```

Save the product ID:

```bash
export PRODUCT_ID="paste_the_id"
```

### 13.3 Add stock (triggers GL posting)

This is the first GL-triggering operation. If Luca is not running, this will fail with a connection error — that's expected. The local database transaction will roll back.

```bash
curl -s -X POST http://localhost:3000/api/v1/stock-items/adjust \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"productId\": \"$PRODUCT_ID\",
    \"warehouseId\": \"$WAREHOUSE_ID\",
    \"type\": \"ADD\",
    \"quantity\": 50,
    \"valuePerUnit\": 12.50,
    \"reason\": \"Initial stock load for testing\"
  }" | jq .
```

**What happens internally:**
1. Creates 50 stock item records (status: IN_STOCK, value: £12.50 each)
2. Calls `LucaGLService.postStockAdjustment()` → MANUAL_JOURNAL (Debit 1150 Stock £625, Credit 5020 Write-Back £625)
3. Logs the GL posting in `gl_posting_log`

### 13.4 Check stock levels

```bash
curl -s "http://localhost:3000/api/v1/products/$PRODUCT_ID/stock-level" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Should show 50 units IN_STOCK.

### 13.5 Create a customer

```bash
curl -s -X POST http://localhost:3000/api/v1/customers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Corporation",
    "email": "orders@acme.example.com",
    "creditTermDays": 30
  }' | jq .
```

Save the customer ID:

```bash
export CUSTOMER_ID="paste_the_id"
```

### 13.6 Create an order

```bash
curl -s -X POST http://localhost:3000/api/v1/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"customerId\": \"$CUSTOMER_ID\",
    \"warehouseId\": \"$WAREHOUSE_ID\",
    \"orderDate\": \"2026-04-12\",
    \"currencyCode\": \"GBP\",
    \"lines\": [
      {
        \"productId\": \"$PRODUCT_ID\",
        \"quantity\": 10,
        \"pricePerUnit\": 25.00,
        \"taxRate\": 20
      }
    ]
  }" | jq .
```

Save the order ID:

```bash
export ORDER_ID="paste_the_id"
```

**What happens:** Creates order SO-000001 with 1 line (10 × Widget Pro X1 @ £25 each, 20% VAT = £50 tax, £300 grand total).

### 13.7 Allocate stock to the order (FIFO)

```bash
curl -s -X POST "http://localhost:3000/api/v1/orders/$ORDER_ID/allocate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"warehouseId\": \"$WAREHOUSE_ID\"}" | jq .
```

**What happens:** The 10 oldest IN_STOCK items (FIFO) are marked as ALLOCATED with `salesOrderId` set to this order. The order status changes to ALLOCATED.

### 13.8 Invoice the order (triggers GL posting)

```bash
curl -s -X POST "http://localhost:3000/api/v1/orders/$ORDER_ID/invoice" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

**What happens internally:**
1. Creates invoice INV-000001 (line total: £250, tax: £50, grand total: £300)
2. Marks 10 ALLOCATED stock items → SOLD
3. Updates order: status=INVOICED, revenue=£250, cogs=£125, margin=£125
4. **GL Post 1:** CUSTOMER_INVOICE → Luca (Debit AR £300, Credit Revenue £250, Credit VAT £50)
5. **GL Post 2:** MANUAL_JOURNAL → Luca (Debit COGS £125, Credit Stock £125)

Save the invoice ID from the response:

```bash
export INVOICE_ID="paste_the_id"
```

### 13.9 Record a payment (triggers GL posting)

```bash
curl -s -X POST "http://localhost:3000/api/v1/invoices/$INVOICE_ID/payment" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount": 300, "paymentDate": "2026-04-15", "reference": "BACS-001"}' | jq .
```

**What happens:** Creates an allocation record, reduces invoice outstanding to £0, changes status to PAID, posts CUSTOMER_PAYMENT to Luca.

### 13.10 Check the GL posting log

```bash
docker compose exec postgres psql -U smmta -d smmta_next \
  -c "SELECT entity_type, luca_transaction_type, status, amount, idempotency_key FROM gl_posting_log ORDER BY created_at;"
```

This shows every GL posting the system attempted, whether it succeeded or failed, and the idempotency key used.

---

## 14. Run as a Production Service

For long-running use, don't run the server manually. Use `systemd` to run it as a background service that auto-restarts.

### 14.1 Build the TypeScript

```bash
cd ~/smmta-next/packages/shared-types && npx tsc
cd ~/smmta-next/apps/api && npx tsc
```

This compiles all `.ts` files to `.js` in the `dist/` directory.

### 14.2 Create a systemd service file

```bash
sudo nano /etc/systemd/system/smmta-api.service
```

Paste:

```ini
[Unit]
Description=SMMTA-Next API Server
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=smmta
WorkingDirectory=/home/smmta/smmta-next/apps/api
EnvironmentFile=/home/smmta/smmta-next/apps/api/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**What each section means:**
- `[Unit]`: Metadata. `After=docker.service` means wait for Docker to start first (PostgreSQL/Redis need to be running).
- `[Service]`: How to run it. `Restart=always` means if the process crashes, systemd will restart it after 5 seconds. `EnvironmentFile` loads the `.env` variables.
- `[Install]`: `WantedBy=multi-user.target` means start this service at boot time.

### 14.3 Enable and start the service

```bash
sudo systemctl daemon-reload      # Tell systemd about the new file
sudo systemctl enable smmta-api   # Start automatically on boot
sudo systemctl start smmta-api    # Start it now
```

### 14.4 Check it's running

```bash
sudo systemctl status smmta-api
```

Should show `active (running)`. View logs:

```bash
sudo journalctl -u smmta-api -f
```

The `-f` flag follows the log output in real time (like `tail -f`). Press `Ctrl+C` to stop watching.

---

## 15. Set Up Nginx Reverse Proxy

Nginx sits in front of the Node.js API, handling SSL termination, compression, and forwarding requests to port 3000.

### 15.1 Install Nginx

```bash
sudo apt install -y nginx
```

### 15.2 Create the site configuration

```bash
sudo nano /etc/nginx/sites-available/smmta-api
```

Paste:

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_IP;

    # Max upload size (for CSV imports, product images)
    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

**Replace `YOUR_DOMAIN_OR_IP`** with your VPS's domain name or IP address.

**What each directive does:**
- `proxy_pass`: Forward all requests to the Node.js API on port 3000
- `proxy_http_version 1.1` + `Upgrade`/`Connection`: Support WebSocket connections (for future real-time features)
- `X-Real-IP` / `X-Forwarded-For`: Pass the client's real IP address through to the API (otherwise the API only sees 127.0.0.1)
- `client_max_body_size 50M`: Allow uploads up to 50MB (needed for CSV order imports)

### 15.3 Enable the site

```bash
sudo ln -s /etc/nginx/sites-available/smmta-api /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default    # Remove default site
sudo nginx -t                                   # Test the config for syntax errors
sudo systemctl restart nginx
```

Now the API is accessible at `http://YOUR_DOMAIN_OR_IP/health`.

### 15.4 Add HTTPS with Let's Encrypt (recommended)

If you have a domain name pointed at the VPS:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_DOMAIN
```

Certbot will:
- Obtain a free SSL certificate from Let's Encrypt
- Modify the Nginx config to serve HTTPS
- Set up auto-renewal (certificates expire every 90 days but renewal is automatic)

---

## 16. Firewall and Security

### 16.1 Configure UFW (Uncomplicated Firewall)

```bash
sudo ufw allow OpenSSH       # Allow SSH (port 22) — CRITICAL: don't lock yourself out
sudo ufw allow 'Nginx Full'  # Allow HTTP (80) and HTTPS (443)
sudo ufw enable
```

**Important:** Always allow SSH before enabling the firewall, or you'll be locked out of your server.

**Ports that should NOT be exposed externally:**
- 5432 (PostgreSQL) — only the API should access it via localhost
- 6379 (Redis) — same
- 3000 (Node.js API) — Nginx proxies to it; direct access isn't needed

### 16.2 Check firewall status

```bash
sudo ufw status
```

Should show SSH, Nginx Full as ALLOW.

---

## 17. Monitoring and Logs

### 17.1 API logs

```bash
sudo journalctl -u smmta-api -n 100    # Last 100 lines
sudo journalctl -u smmta-api -f        # Follow live
sudo journalctl -u smmta-api --since "1 hour ago"
```

### 17.2 Docker container logs

```bash
cd ~/smmta-next
docker compose logs postgres --tail 50   # Last 50 lines from PostgreSQL
docker compose logs redis --tail 50      # Last 50 lines from Redis
```

### 17.3 Database queries

Connect directly to PostgreSQL:

```bash
docker compose exec postgres psql -U smmta -d smmta_next
```

Useful queries:

```sql
-- Count all records per table
SELECT schemaname, relname, n_live_tup
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;

-- Check GL posting log for failures
SELECT * FROM gl_posting_log WHERE status = 'FAILED';

-- Count orders by status
SELECT status, COUNT(*) FROM customer_orders GROUP BY status;

-- Stock valuation
SELECT p.name, SUM(s.quantity) as qty, SUM(CAST(s.value AS NUMERIC) * s.quantity) as total_value
FROM stock_items s
JOIN products p ON p.id = s.product_id
WHERE s.status = 'IN_STOCK' AND s.deleted_at IS NULL
GROUP BY p.name;
```

Exit psql with `\q`.

### 17.4 Disk usage

```bash
docker system df           # Docker disk usage
df -h                      # Overall disk usage
```

---

## 18. Troubleshooting

### "Connection refused" on port 3000

The API isn't running. Check:

```bash
sudo systemctl status smmta-api
sudo journalctl -u smmta-api -n 50
```

Common cause: PostgreSQL isn't ready when the API starts. Fix: restart the service.

```bash
sudo systemctl restart smmta-api
```

### "relation does not exist" errors

The schema hasn't been pushed to the database. Run:

```bash
cd ~/smmta-next/apps/api
npx drizzle-kit push
```

### Docker containers not starting

```bash
docker compose down
docker compose up -d
docker compose ps       # Check status
docker compose logs     # Check for errors
```

Common cause: Port conflict (another service on 5432 or 6379). Fix:

```bash
sudo lsof -i :5432    # See what's using the port
```

### GL posting failures (expected without Luca)

If Luca isn't running, any GL-triggering operation (stock adjust, invoice, payment, etc.) will fail. The error will appear in:

```sql
SELECT * FROM gl_posting_log WHERE status = 'FAILED' ORDER BY created_at DESC LIMIT 10;
```

This is expected during testing. Non-GL operations (CRUD for products, customers, orders, suppliers) work independently.

To test WITH Luca, set `LUCA_API_BASE_URL` in your `.env` to point at a running Luca instance, then restart the service:

```bash
sudo systemctl restart smmta-api
```

### npm install fails with "EACCES" or permissions errors

```bash
sudo chown -R smmta:smmta ~/smmta-next
```

### "Cannot find module '@smmta/shared-types'"

The shared-types package hasn't been built:

```bash
cd ~/smmta-next/packages/shared-types && npx tsc
```

---

## Quick Reference Card

| Action | Command |
|--------|---------|
| Start database + Redis | `cd ~/smmta-next && docker compose up -d` |
| Stop database + Redis | `cd ~/smmta-next && docker compose down` |
| Start API service | `sudo systemctl start smmta-api` |
| Stop API service | `sudo systemctl stop smmta-api` |
| Restart API service | `sudo systemctl restart smmta-api` |
| View API logs | `sudo journalctl -u smmta-api -f` |
| Push schema changes | `cd ~/smmta-next/apps/api && npx drizzle-kit push` |
| Open database shell | `docker compose exec postgres psql -U smmta -d smmta_next` |
| Run in dev mode | `cd ~/smmta-next/apps/api && npx tsx src/server.ts` |
| Health check | `curl http://localhost:3000/health` |
| Run Luca account setup | `cd ~/smmta-next/apps/api && npx tsx src/migration/luca-setup.ts` |
| Run data migration | `cd ~/smmta-next/apps/api && npx tsx src/migration/etl-runner.ts` |
| Run opening balances | `cd ~/smmta-next/apps/api && npx tsx src/migration/opening-balances.ts` |
| Verify migration | `cd ~/smmta-next/apps/api && npx tsx src/migration/verify-migration.ts` |
