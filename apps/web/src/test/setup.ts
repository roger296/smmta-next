import { expect, afterAll, afterEach, beforeAll } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import { server } from './mocks/server';

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
