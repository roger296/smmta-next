import { LucaClient } from '../integrations/luca/luca-client.js';
import { ACCOUNTS_TO_CREATE } from '../integrations/luca/luca-account-map.js';

/**
 * Luca Account Setup Script
 *
 * Creates the GL accounts needed in Luca that don't exist in its default chart.
 * Run this ONCE before go-live:
 *   npx tsx src/migration/luca-setup.ts
 *
 * Accounts created:
 *   1150 Stock (Inventory)
 *   2310 GRNI Accrual
 *   2320 Delivery GRNI Accrual
 *   2330 Service GRNI Accrual
 *   5010 Stock Write-Offs
 *   5020 Stock Write-Back
 *   5030 Delivery Costs In
 */
async function main() {
  const client = new LucaClient();

  console.log('=== Luca GL Account Setup ===\n');
  console.log(`Target: ${process.env.LUCA_API_BASE_URL ?? 'http://localhost:4000'}\n`);

  for (const account of ACCOUNTS_TO_CREATE) {
    try {
      console.log(`Creating account ${account.code} — ${account.name} (${account.type})...`);
      await client.createAccount(account);
      console.log(`  ✓ Created successfully`);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        console.log(`  ⏭ Already exists — skipping`);
      } else {
        console.error(`  ✗ Failed: ${msg}`);
      }
    }
  }

  console.log('\n=== Setup complete ===');

  // Verify by listing accounts
  try {
    console.log('\nVerifying — listing all accounts...');
    const accounts = await client.listAccounts();
    console.log('Account list retrieved successfully.');
  } catch (err) {
    console.warn('Could not verify accounts:', (err as Error).message);
  }
}

main().catch(console.error);
