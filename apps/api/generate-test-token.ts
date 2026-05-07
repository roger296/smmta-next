import jwt from 'jsonwebtoken';
import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import { getSingletonCompanyId } from './src/shared/auth/company.js';

config();

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error('ERROR: JWT_SECRET not found in .env');
  process.exit(1);
}

const payload = {
  userId: randomUUID(),
  companyId: getSingletonCompanyId(),
  email: 'test@example.com',
  roles: ['admin'],
};

const token = jwt.sign(payload, secret, { expiresIn: '30d' });

console.log('\n=== TEST JWT TOKEN ===');
console.log(token);
console.log('\n=== PAYLOAD ===');
console.log(JSON.stringify(payload, null, 2));
console.log('');
