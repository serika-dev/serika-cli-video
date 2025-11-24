#!/usr/bin/env node
import axios from 'axios';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { spawn } from 'child_process';
import ora from 'ora';

import Conf from 'conf';

const config = new Conf({
  projectName: 'serika-cli',
  defaults: {
    asciiMode: false,
    asciiWidth: 80,
    asciiCharset: 'standard'
  }
});

const CHARSETS = {
  standard: ' .:-=+*#%@',
  simple: ' .:+@',
  blocks: ' ░▒▓█',
  solid: '█'
};

const API_URL = 'https://serika.app/api';

async function fetchVideos() {
  const spinner = ora('Fetching videos from Serika...').start();
  try {
    const response = await axios.get(`${API_URL}/videos`);
    spinner.stop();
    return response.data.videos;
  } catch (error) {
    spinner.fail('Failed to fetch videos');
    console.error(chalk.red(error.message));
    if (error.code === 'ECONNREFUSED') {
      console.log(chalk.yellow(`Make sure the Serika server is running at ${API_URL}`));
    }
    process.exit(1);
  }
}

function playVideo(url) {
  if (config.get('asciiMode')) {
    return playVideoAscii(url);
  }

  console.log(chalk.green(`Playing video: ${url}`));
  console.log(chalk.gray('Press q to quit playback'));

  const player = spawn('ffplay', ['-autoexit', '-hide_banner', url], {
    stdio: 'inherit'
  });

  return new Promise((resolve) => {
    player.on('close', () => {
      resolve();
    });
  });
}

function playVideoAscii(url) {
  return new Promise((resolve, reject) => {
    const width = config.get('asciiWidth') || process.stdout.columns || 80;
    // Calculate height based on 16:9 aspect ratio and ~0.5 char aspect ratio
    // Height = Width * (9/16) * 0.5
    const height = Math.floor(width * (9 / 16) * 0.55); 

    // Start audio player in background
    const audioPlayer = spawn('ffplay', ['-nodisp', '-autoexit', '-hide_banner', url], {
      stdio: 'ignore'
    });

    const ffmpeg = spawn('ffmpeg', [
      '-re',
      '-i', url,
      '-vf', `scale=${width}:${height}`,
      '-f', 'image2pipe',
      '-vcodec', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-'
    ], {
      stdio: ['ignore', 'pipe', 'ignore'] // Ignore stderr to avoid noise
    });

    const frameSize = width * height * 3;
    let buffer = Buffer.alloc(0);
    let firstFrame = true;

    const charsetName = config.get('asciiCharset');
    const chars = CHARSETS[charsetName] || CHARSETS.standard;
    
    ffmpeg.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= frameSize) {
        const frame = buffer.subarray(0, frameSize);
        buffer = buffer.subarray(frameSize);

        if (firstFrame) {
          console.clear();
          // Hide cursor
          process.stdout.write('\x1B[?25l');
          firstFrame = false;
        }

        let output = '\x1B[H'; // Move cursor to home
        
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 3;
            const r = frame[offset];
            const g = frame[offset + 1];
            const b = frame[offset + 2];
            
            const brightness = (r + g + b) / 3;
            const charIndex = Math.floor((brightness / 255) * (chars.length - 1));
            const char = chars[charIndex];

            // Optimization: Group same-colored chars? 
            // For now, just print every char with its color.
            // Using chalk for every char is too slow/verbose for raw output.
            // Use raw ANSI codes for speed.
            output += `\x1b[38;2;${r};${g};${b}m${char}`;
          }
          output += '\n';
        }
        output += '\x1b[0m'; // Reset color
        process.stdout.write(output);
      }
    });

    const cleanup = () => {
      ffmpeg.kill();
      audioPlayer.kill();
      console.clear();
    };

    ffmpeg.on('close', () => {
      cleanup();
      resolve();
    });

    // Handle Ctrl+C to stop playback without killing the CLI
    const onSigInt = () => {
      cleanup();
      process.removeListener('SIGINT', onSigInt);
      // We don't resolve here, ffmpeg close event will handle it
    };
    process.on('SIGINT', onSigInt);
  });
}

async function settingsMenu() {
  while (true) {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'setting',
        message: 'Settings',
        choices: [
          { name: `ASCII Mode: ${config.get('asciiMode') ? chalk.green('ON') : chalk.red('OFF')}`, value: 'asciiMode' },
          { name: `ASCII Width: ${config.get('asciiWidth')}`, value: 'asciiWidth' },
          { name: `ASCII Charset: ${config.get('asciiCharset')}`, value: 'asciiCharset' },
          new inquirer.Separator(),
          { name: 'Back', value: 'back' }
        ]
      }
    ]);

    if (answers.setting === 'back') break;

    if (answers.setting === 'asciiMode') {
      config.set('asciiMode', !config.get('asciiMode'));
    } else if (answers.setting === 'asciiWidth') {
      const { width } = await inquirer.prompt([
        {
          type: 'number',
          name: 'width',
          message: 'Enter ASCII width (characters):',
          default: config.get('asciiWidth')
        }
      ]);
      config.set('asciiWidth', width);
    } else if (answers.setting === 'asciiCharset') {
      const { charset } = await inquirer.prompt([
        {
          type: 'list',
          name: 'charset',
          message: 'Select ASCII Charset:',
          choices: Object.keys(CHARSETS),
          default: config.get('asciiCharset')
        }
      ]);
      config.set('asciiCharset', charset);
    }
  }
}

async function main() {
  console.log(chalk.bold.blue('Welcome to Serika CLI! 📺'));

  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Browse Videos', value: 'browse' },
          { name: 'Search Videos', value: 'search' },
          { name: 'Settings', value: 'settings' },
          { name: 'Exit', value: 'exit' }
        ]
      }
    ]);

    if (action === 'exit') {
      console.log(chalk.blue('Goodbye! 👋'));
      process.exit(0);
    }

    if (action === 'settings') {
      await settingsMenu();
      continue;
    }

    const videos = await fetchVideos();
    let filteredVideos = videos;

    if (action === 'search') {
      const { query } = await inquirer.prompt([
        {
          type: 'input',
          name: 'query',
          message: 'Search query:'
        }
      ]);
      
      const lowerQuery = query.toLowerCase();
      filteredVideos = videos.filter(v => 
        v.title.toLowerCase().includes(lowerQuery) || 
        (v.userId?.username || '').toLowerCase().includes(lowerQuery)
      );

      if (filteredVideos.length === 0) {
        console.log(chalk.yellow('No videos found matching your query.'));
        continue;
      }
    }

    const choices = filteredVideos.map(v => ({
      name: `${v.isLive ? chalk.red('[LIVE] ') : ''}${v.title} ${chalk.gray(`by ${v.userId?.username || 'Unknown'}`)}`,
      value: v
    }));

    choices.push(new inquirer.Separator());
    choices.push({ name: chalk.yellow('Back to Menu'), value: 'back' });

    const { video } = await inquirer.prompt([
      {
        type: 'list',
        name: 'video',
        message: 'Select a video to watch:',
        pageSize: 15,
        choices
      }
    ]);

    if (video === 'back') {
      continue;
    }

    // Prefer MP4 URL for ffplay compatibility, fallback to DASH
    const playUrl = video.videoUrl || video.dashUrl;
    
    if (!playUrl) {
      console.log(chalk.red('Error: No video URL found for this video.'));
      continue;
    }

    await playVideo(playUrl);
  }
}

main().catch(console.error);
