#!/usr/bin/env node
import { run } from '../cli/index.js';

const exitCode = await run(process.argv);
if (exitCode !== 0) process.exitCode = exitCode;
