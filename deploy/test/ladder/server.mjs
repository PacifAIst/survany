// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
// Starts Google Chrome as a Playwright browser server with the flags in CHROME_ARGS (JSON array), so each
// test container's browser is configured in compose, not by the client.
import { chromium } from 'playwright';

const args = JSON.parse(process.env.CHROME_ARGS ?? '[]');
const server = await chromium.launchServer({ channel: 'chrome', headless: true, args, host: '0.0.0.0', port: 3000, wsPath: '/pw' });
console.info(`browser server ${server.wsEndpoint()} args=${JSON.stringify(args)}`);
