/**
 * Import a SendGrid export (or any contact list) into the email system.
 * Always a dry run first; a live run needs the dry run's id.
 *
 *   npx tsx apps/api/scripts/email/import.ts --type bounces --file imports/sendgrid/bounces.csv
 *   npx tsx apps/api/scripts/email/import.ts --type bounces --file imports/sendgrid/bounces.csv --live --dry-run-id <id>
 *
 * Order: bounces → spam_reports → unsubscribes → contacts, so the safest
 * status wins. Options: --default-interests material:pla,material:petg (a
 * contacts list defaults to every material at the "interested" score),
 * --consent-source <source> (default sendgrid_import), --actor <name>.
 * Prints counts only, never addresses (conflicts are masked).
 */
import { closeDatabase } from '../../src/config/database.js';
import {
  ALL_MATERIAL_INTERESTS,
  ImportRefusedError,
  ImportsService,
  LIST_TYPES,
  type ListType,
} from '../../src/modules/email/services/imports.service.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const type = arg('type') as ListType | undefined;
  const file = arg('file');
  if (!type || !LIST_TYPES.includes(type) || !file) {
    console.error(`usage: --type ${LIST_TYPES.join('|')} --file <path> [--live --dry-run-id <id>]`);
    process.exitCode = 2;
    return;
  }
  const live = process.argv.includes('--live');
  const interests = arg('default-interests');
  try {
    const report = await new ImportsService().run({
      filePath: file,
      listType: type,
      dryRun: !live,
      dryRunId: arg('dry-run-id'),
      defaultInterests: interests ? interests.split(',') : type === 'contacts' ? ALL_MATERIAL_INTERESTS : [],
      consentSource: arg('consent-source'),
      actor: arg('actor') ?? 'cli',
    });
    console.log(JSON.stringify(report, null, 2));
    if (!live) console.log(`\nDry run id: ${report.importId}\nRe-run with --live --dry-run-id ${report.importId} to apply.`);
  } catch (err) {
    if (err instanceof ImportRefusedError) {
      console.error(`Refused (${err.code}): ${err.message}`);
      process.exitCode = 1;
    } else throw err;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
