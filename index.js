#!/usr/bin/env node
import axios from 'axios';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { spawn } from 'child_process';
import ora from 'ora';
import os from 'os';
import fs from 'fs';
import path from 'path';

import Conf from 'conf';

const config = new Conf({
  projectName: 'serika-cli',
  defaults: {
    asciiMode: false,
    asciiWidth: 80,
    asciiCharset: 'standard',
    downloadDir: '.',
    downloadQuality: 'original',
    autoMergeAudio: true
  }
});

const CHARSETS = {
  standard: ' .:-=+*#%@',
  simple: ' .:+@',
  blocks: ' ░▒▓█',
  solid: '█'
};

const API_URL = process.env.SERIKA_API_URL || 'https://serika.video/api';
const isWindows = os.platform() === 'win32';

async function fetchVideos() {
  const spinner = ora('Fetching videos from Serika...').start();
  try {
    const response = await axios.get(`${API_URL}/videos`, { timeout: 30000 });
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

  // Try ffplay first, fallback to opening in browser on Windows
  const playerCommand = isWindows ? 'ffplay.exe' : 'ffplay';
  const player = spawn(playerCommand, ['-autoexit', '-hide_banner', url], {
    stdio: 'inherit'
  });

  return new Promise((resolve) => {
    player.on('error', (err) => {
      if (isWindows && err.code === 'ENOENT') {
        console.log(chalk.yellow('\nffplay not found. Opening video in browser...'));
        // Fallback to opening in default browser on Windows
        spawn('cmd.exe', ['/c', 'start', url], { detached: true, stdio: 'ignore' });
        resolve();
      } else {
        console.error(chalk.red('Error playing video:', err.message));
        resolve();
      }
    });

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

    // Check if Windows Terminal supports ANSI
    if (isWindows && !process.env.WT_SESSION && !process.env.TERM_PROGRAM) {
      console.log(chalk.yellow('ASCII mode requires Windows Terminal or a compatible terminal.'));
      console.log(chalk.yellow('Playing in normal mode instead...'));
      return playVideo(url);
    }

    // Start audio player in background
    const audioPlayerCmd = isWindows ? 'ffplay.exe' : 'ffplay';
    const audioPlayer = spawn(audioPlayerCmd, ['-nodisp', '-autoexit', '-hide_banner', url], {
      stdio: 'ignore'
    });

    const ffmpegCmd = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
    
    // Use lower FPS on Windows for better performance and stability
    const targetFPS = isWindows ? 12 : 15;
    const ffmpegArgs = [
      '-re', // Read input at native frame rate - critical for proper timing
      '-i', url,
      '-vf', `scale=${width}:${height},fps=${targetFPS}`,
      '-f', 'image2pipe',
      '-vcodec', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-'
    ];
    
    const ffmpeg = spawn(ffmpegCmd, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'ignore']
    });

    const frameSize = width * height * 3;
    let buffer = Buffer.alloc(0);
    let firstFrame = true;
    let frameCount = 0;
    
    // Frame queue to prevent burst rendering
    const frameQueue = [];
    let isProcessing = false;

    const charsetName = config.get('asciiCharset');
    const chars = CHARSETS[charsetName] || CHARSETS.standard;
    
    // Optimized frame rendering
    const renderFrame = (frame) => {
      if (firstFrame) {
        console.clear();
        process.stdout.write('\x1B[?25l');
        firstFrame = false;
      }

      // Use single string builder for better performance
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
          
          output += `\x1b[38;2;${r};${g};${b}m${char}`;
        }
        output += '\n';
      }
      output += '\x1b[0m';
      
      process.stdout.write(output);
      frameCount++;
    };
    
    // Process next frame from queue
    const processNextFrame = () => {
      if (isProcessing || frameQueue.length === 0) return;
      
      isProcessing = true;
      const frame = frameQueue.shift();
      
      renderFrame(frame);
      
      // Schedule next frame processing
      isProcessing = false;
      if (frameQueue.length > 0) {
        setImmediate(processNextFrame);
      }
    };
    
    ffmpeg.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= frameSize) {
        const frame = buffer.subarray(0, frameSize);
        buffer = buffer.subarray(frameSize);
        
        // Add frame to queue instead of processing immediately
        frameQueue.push(Buffer.from(frame));
        
        // Keep queue size reasonable to prevent memory issues
        if (frameQueue.length > 30) {
          frameQueue.shift(); // Drop oldest frame if queue too large
        }
      }
      
      // Start processing if not already running
      if (!isProcessing) {
        processNextFrame();
      }
    });

    let cleanedUp = false;
    
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      
      // Restore terminal state
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      process.stdin.removeListener('data', onKeyPress);
      if (ffmpeg && !ffmpeg.killed) ffmpeg.kill();
      if (audioPlayer && !audioPlayer.killed) audioPlayer.kill();
      process.stdout.write('\x1B[?25h'); // Show cursor
      console.clear();
    };

    // Handle keyboard input for stopping playback
    const onKeyPress = (key) => {
      // Ctrl+C (0x03) or 'q' to quit
      if (key[0] === 0x03 || key.toString().toLowerCase() === 'q') {
        cleanup();
        // Small delay to let terminal reset before inquirer takes over
        setTimeout(() => resolve(), 100);
      }
    };

    // Enable raw mode to capture Ctrl+C without exiting
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', onKeyPress);
    }

    ffmpeg.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.log(chalk.red(`\n${ffmpegCmd} not found. Please install ffmpeg to use ASCII mode.`));
        if (isWindows) {
          console.log(chalk.yellow('Install via: winget install ffmpeg or choco install ffmpeg'));
        }
      }
      cleanup();
      resolve();
    });

    ffmpeg.on('close', () => {
      cleanup();
      resolve();
    });
  });
}

async function downloadVideo(videoUrl, audioUrl, title) {
  // Sanitize filename
  const sanitizedTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const filename = `${sanitizedTitle}.mp4`;
  
  // Get download directory from config, expand ~ to home directory
  let downloadDir = config.get('downloadDir');
  if (downloadDir.startsWith('~')) {
    downloadDir = path.join(os.homedir(), downloadDir.slice(1));
  }
  
  // Create directory if it doesn't exist
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }
  
  const downloadPath = path.join(downloadDir, filename);

  const spinner = ora(`Downloading: ${title}`).start();

  // If we have separate audio and video URLs (DASH), use ffmpeg to merge
  if (audioUrl && audioUrl !== videoUrl && config.get('autoMergeAudio')) {
    const ffmpegCmd = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
    const quality = config.get('downloadQuality');
    
    return new Promise((resolve, reject) => {
      const args = [
        '-i', videoUrl,
        '-i', audioUrl
      ];
      
      // Add encoding options based on quality setting
      if (quality === 'original') {
        args.push('-c', 'copy');
      } else if (quality === 'high') {
        args.push('-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', '-b:a', '192k');
      } else if (quality === 'medium') {
        args.push('-c:v', 'libx264', '-crf', '23', '-c:a', 'aac', '-b:a', '128k');
      } else if (quality === 'low') {
        args.push('-c:v', 'libx264', '-crf', '28', '-c:a', 'aac', '-b:a', '96k');
      }
      
      args.push('-y', downloadPath);
      
      const ffmpeg = spawn(ffmpegCmd, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let lastProgress = 0;
      
      ffmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        // Parse ffmpeg progress output
        const timeMatch = output.match(/time=(\d+):(\d+):(\d+)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const seconds = parseInt(timeMatch[3]);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          
          // Update every 5 seconds to avoid spam
          if (totalSeconds > lastProgress + 5) {
            lastProgress = totalSeconds;
            spinner.text = `Downloading: ${title} (${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s)`;
          }
        }
      });

      ffmpeg.on('error', (err) => {
        if (err.code === 'ENOENT') {
          spinner.fail(chalk.red('ffmpeg not found'));
          console.log(chalk.yellow('Please install ffmpeg to download videos with audio.'));
          if (isWindows) {
            console.log(chalk.yellow('Install via: winget install ffmpeg or choco install ffmpeg'));
          }
        } else {
          spinner.fail(chalk.red('Download failed'));
          console.error(chalk.red(err.message));
        }
        // Clean up partial file
        if (fs.existsSync(downloadPath)) {
          fs.unlinkSync(downloadPath);
        }
        reject(err);
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          spinner.succeed(chalk.green(`Downloaded: ${filename}`));
          console.log(chalk.gray(`Saved to: ${downloadPath}`));
          resolve();
        } else {
          spinner.fail(chalk.red('Download failed'));
          // Clean up partial file
          if (fs.existsSync(downloadPath)) {
            fs.unlinkSync(downloadPath);
          }
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });
    });
  }

  // Single URL download (simple streaming)
  try {
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'stream'
    });

    const totalSize = parseInt(response.headers['content-length'], 10);
    let downloadedSize = 0;

    const writer = fs.createWriteStream(downloadPath);

    response.data.on('data', (chunk) => {
      downloadedSize += chunk.length;
      if (totalSize) {
        const percent = Math.round((downloadedSize / totalSize) * 100);
        spinner.text = `Downloading: ${title} (${percent}%)`;
      }
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        spinner.succeed(chalk.green(`Downloaded: ${filename}`));
        console.log(chalk.gray(`Saved to: ${downloadPath}`));
        resolve();
      });

      writer.on('error', (err) => {
        spinner.fail(chalk.red('Download failed'));
        console.error(chalk.red(err.message));
        // Clean up partial file
        if (fs.existsSync(downloadPath)) {
          fs.unlinkSync(downloadPath);
        }
        reject(err);
      });
    });
  } catch (error) {
    spinner.fail(chalk.red('Download failed'));
    console.error(chalk.red(error.message));
    throw error;
  }
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
          { name: `Download Directory: ${config.get('downloadDir')}`, value: 'downloadDir' },
          { name: `Download Quality: ${config.get('downloadQuality')}`, value: 'downloadQuality' },
          { name: `Auto-merge Audio: ${config.get('autoMergeAudio') ? chalk.green('ON') : chalk.red('OFF')}`, value: 'autoMergeAudio' },
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
    } else if (answers.setting === 'downloadDir') {
      const { dir } = await inquirer.prompt([
        {
          type: 'input',
          name: 'dir',
          message: 'Enter download directory path (use . for current, ~ for home):',
          default: config.get('downloadDir')
        }
      ]);
      config.set('downloadDir', dir);
    } else if (answers.setting === 'downloadQuality') {
      const { quality } = await inquirer.prompt([
        {
          type: 'list',
          name: 'quality',
          message: 'Select download quality:',
          choices: [
            { name: 'Original (no re-encoding, fastest)', value: 'original' },
            { name: 'High (CRF 18, ~192kbps audio)', value: 'high' },
            { name: 'Medium (CRF 23, ~128kbps audio)', value: 'medium' },
            { name: 'Low (CRF 28, ~96kbps audio)', value: 'low' }
          ],
          default: config.get('downloadQuality')
        }
      ]);
      config.set('downloadQuality', quality);
    } else if (answers.setting === 'autoMergeAudio') {
      config.set('autoMergeAudio', !config.get('autoMergeAudio'));
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

    // Ask user what to do with the video
    const { videoAction } = await inquirer.prompt([
      {
        type: 'list',
        name: 'videoAction',
        message: `What would you like to do with "${video.title}"?`,
        choices: [
          { name: 'Play Video', value: 'play' },
          { name: 'Download Video', value: 'download' },
          { name: 'Back', value: 'back' }
        ]
      }
    ]);

    if (videoAction === 'back') {
      continue;
    }

    if (videoAction === 'download') {
      if (video.isLive) {
        console.log(chalk.yellow('Cannot download live videos.'));
        continue;
      }
      
      try {
        // Pass both video and audio URLs for DASH videos
        const videoUrl = video.videoUrl || video.dashUrl;
        const audioUrl = video.audioUrl || null;
        await downloadVideo(videoUrl, audioUrl, video.title);
      } catch (error) {
        // Error already logged in downloadVideo
      }
    } else if (videoAction === 'play') {
      await playVideo(playUrl);
    }
  }
}

main().catch(console.error);
