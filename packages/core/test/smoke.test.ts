import { expect, test } from 'vitest';
import { VERSION } from '../src/index.js';

test('core package resolves', () => {
  expect(VERSION).toBe('0.1.0');
});
