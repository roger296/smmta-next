/**
 * register-smooth-parcel-account.ts — create the dedicated Smooth Parcel account
 * this store buys labels through, together with its API key.
 *
 * Smooth Parcel's label API does not accept the web login token. Each account
 * has an API access key instead, sent as the raw Authorization header, and the
 * key is set when the account is created, by POST /api/APIAccess/CreateCustomer.
 * That is how the ETS/SMMTA application connected
 * (ThreePLAccountService.CreateSmoothParcelAccount). It creates a NEW account:
 * an email address that already has one is refused, so use one that does not.
 *
 * Reads, from the environment Coolify sets:
 *   SMOOTH_PARCEL_USERNAME   the new account's email address
 *   SMOOTH_PARCEL_PASSWORD   its password
 *   SMOOTH_PARCEL_API_KEY    must be empty; the script refuses to run if a key is set
 *
 * The key is written to a file on the private labels volume and never printed,
 * so pasting this script's output anywhere cannot leak it. The file is written
 * BEFORE the account is created, so a dropped connection cannot lose the key
 * of an account Smooth Parcel did create. Copy the key into Coolify as
 * SMOOTH_PARCEL_API_KEY, then delete the file.
 *
 * Usage (inside the api container):
 *   npx tsx apps/api/scripts/register-smooth-parcel-account.ts --name "..." --address1 "..." --city "..." --postcode "..."
 *       Check only: shows what would be sent and Smooth Parcel's answer for the email. Creates nothing.
 *   ...the same flags... --create
 *       Creates the account.
 *
 * Flags:
 *   --name <text>       Account name (required)
 *   --country <text>    Default "United Kingdom"
 *   --address1 <text>   Collection address, line 1
 *   --city <text>
 *   --region <text>     Defaults to the city
 *   --postcode <text>
 *   --create            Actually create the account
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getEnv } from '../src/config/env.js';
import {
  SmoothParcelClient,
  generateApiAccessKey,
} from '../src/integrations/smooth-parcel/smooth-parcel-client.js';

const KEY_FILENAME = 'smooth-parcel-api-key.txt';

interface Args {
  name: string;
  country: string;
  address1: string;
  city: string;
  region: string;
  postcode: string;
  create: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { name: '', country: 'United Kingdom', address1: '', city: '', region: '', postcode: '', create: false };
  const text: Record<string, keyof Omit<Args, 'create'>> = {
    '--name': 'name',
    '--country': 'country',
    '--address1': 'address1',
    '--city': 'city',
    '--region': 'region',
    '--postcode': 'postcode',
  };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--create') {
      out.create = true;
      continue;
    }
    const field = text[flag];
    const value = argv[i + 1];
    if (field && value !== undefined) {
      out[field] = value.trim();
      i++;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!out.name) throw new Error('--name is required');
  out.region ||= out.city;
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const env = getEnv();
  const email = env.SMOOTH_PARCEL_USERNAME.trim();
  const password = env.SMOOTH_PARCEL_PASSWORD;

  console.log(`API:       ${env.SMOOTH_PARCEL_API_BASE_URL}`);
  console.log(`Email:     ${email || 'NOT SET'}`);
  console.log(`Password:  ${password ? 'set' : 'NOT SET'}`);
  if (!email || !password) {
    throw new Error('Set SMOOTH_PARCEL_USERNAME and SMOOTH_PARCEL_PASSWORD in Coolify, redeploy, then run this again.');
  }
  if (env.SMOOTH_PARCEL_API_KEY) {
    throw new Error('SMOOTH_PARCEL_API_KEY is already set, so this store already has an account key. Nothing to do.');
  }

  const keyFile = join(resolve(env.LABELS_DIR), KEY_FILENAME);
  if (existsSync(keyFile)) {
    throw new Error(
      `A key from an earlier run is still in ${keyFile}. If that account was created, put the key into Coolify; ` +
        'if it was not, delete the file. Then run this again.',
    );
  }

  console.log('\nAccount details to send:');
  console.log(`  Name:      ${args.name}`);
  console.log(`  Country:   ${args.country}`);
  console.log(`  Address:   ${[args.address1, args.city, args.region, args.postcode].filter(Boolean).join(', ') || '(none)'}`);

  const client = new SmoothParcelClient({ apiKey: '' });
  const check = await client.checkCustomer(email);
  console.log(`\nSmooth Parcel's answer for this email: IsSuccess=${check.isSuccess}${check.message ? `, "${check.message}"` : ''}`);

  if (!args.create) {
    console.log('\nCheck only: nothing was created. Run again with --create to create the account.');
    return;
  }

  const apiKey = generateApiAccessKey();
  await mkdir(resolve(env.LABELS_DIR), { recursive: true });
  // 'wx' refuses to overwrite; 0o600 keeps it readable by this user only.
  await writeFile(keyFile, `${apiKey}\n`, { flag: 'wx', mode: 0o600 });

  let result;
  try {
    result = await client.createCustomer({
      name: args.name,
      email,
      password,
      apiKey,
      country: args.country,
      address1: args.address1,
      city: args.city,
      region: args.region,
      postcode: args.postcode,
    });
  } catch (err) {
    // No definite answer (timeout, server error): the account may exist, so the key is kept.
    console.error(`\nNo clear answer from Smooth Parcel: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`The account MAY have been created. Its key is kept in ${keyFile}.`);
    console.error('Check the Smooth Parcel portal for this email before doing anything else.');
    process.exitCode = 1;
    return;
  }

  if (!result.created) {
    await rm(keyFile, { force: true });
    console.error(`\nSmooth Parcel refused to create the account${result.message ? `: ${result.message}` : ''}`);
    console.error('Nothing was created, and the unused key has been deleted.');
    process.exitCode = 1;
    return;
  }

  console.log(`\nAccount created${result.message ? `: ${result.message}` : ''}`);
  console.log(`The API key is saved in ${keyFile} (inside the api container). It is not shown here.`);
  console.log('Next: copy it into Coolify as SMOOTH_PARCEL_API_KEY, then delete the file.');
}

main().catch((err: unknown) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
