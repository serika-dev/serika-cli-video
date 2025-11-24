# Serika CLI

Watch Serika videos directly from your terminal!

## Prerequisites

- Node.js
- `ffmpeg` (specifically `ffplay`) installed and available in your PATH.

## Installation

### From NPM (Global)

You can install the CLI globally directly from npm:

```bash
npm install -g @serikavideo/serika-cli
```

This will automatically configure the `serika-cli` command in your terminal.

### Local Development

1. Navigate to this directory:
   ```bash
   cd serika-cli
   ```

2. Install dependencies and link the command:
   ```bash
   npm install
   npm link
   ```

## Usage

1. Ensure the Serika web server is running (usually on `http://localhost:3000`).

2. Run the CLI from anywhere:
   ```bash
   serika-cli
   ```
   
   Or specify a custom API URL:
   ```bash
   SERIKA_API_URL=https://serika.tv/api serika-cli
   ```

3. Select a video from the list to play it in `ffplay`.
