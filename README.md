# Lspace API & MCP Server

> "Books bend space and time... You stray into Lspace at your peril." - Terry Pratchett (Guards! Guards!)

![The Librarian - Lspace Mascot](assets/images/lspace_librarian.png)

Lspace is an open-source API backend and server that implements the **Model Context Protocol (MCP)**. It enables developers to integrate intelligent knowledge base generation and management capabilities into their workflows, connecting AI agents and other tools to managed content repositories. (See [modelcontextprotocol.io](https://modelcontextprotocol.io) for more on MCP).

For comprehensive technical documentation, project details, and an example of a knowledge base built with Lspace, please see the [official Lspace documentation repository](https://github.com/Lspace-io/lspace-docs).

## Quick Start: Using Lspace MCP Server with Clients

This guide helps you set up the Lspace server and configure it for use with Model Context Protocol (MCP) clients like Cursor or Claude Desktop.

**A. Prerequisites:**
1.  **Node.js**: LTS version recommended (includes npm). Download from [nodejs.org](https://nodejs.org).
2.  **npm**: Comes with Node.js.
3.  **Git**: Download from [git-scm.com](https://git-scm.com).

**B. Clone, Install & Build Lspace Server:**
These steps prepare the Lspace server code to be executed by an MCP client.
1.  Clone the Lspace server repository:
    ```bash
    git clone https://github.com/Lspace-io/lspace-server.git
    ```
2.  Navigate into the directory:
    ```bash
    cd lspace-server
    ```
3.  Install dependencies:
    ```bash
    npm install
    ```
4.  Build the project (compiles TypeScript to JavaScript in the `dist/` folder):
    ```bash
    npm run build
    ```
    The main script for the MCP server will be `lspace-mcp-server.js` in the root of this directory after the build.

**C. Configure Your Lspace Server:**
Before an MCP client can use Lspace, you need to configure Lspace itself:
1.  **Environment Variables (`.env` file):**
    *   Copy the example environment file:
        ```bash
        cp .env.example .env
        ```
    *   Edit the new `.env` file.
    *   **Crucially, set your `OPENAI_API_KEY`**.
    *   Review and adjust other variables as needed (see comments in `.env.example`).
2.  **Lspace Repositories & Credentials (`config.local.json` file):**
    *   This file tells Lspace which repositories to manage and provides credentials (like GitHub PATs). It is not committed to Git.
    *   Copy the example configuration file:
        ```bash
        cp config.example.json config.local.json
        ```
    *   Edit `config.local.json`:
        *   Add your GitHub PATs under `credentials.github_pats`. If you need detailed instructions on creating PATs, please see the [Understanding GitHub Personal Access Tokens (PATs) for Lspace](#understanding-github-personal-access-tokens-pats-for-lspace) section below.
        *   Define the local or GitHub repositories Lspace should manage under the `repositories` array.
        *   Refer to the "Managing Repositories Manually (`config.local.json`)" section for detailed structure and examples.

**D. Configuring Lspace in MCP Clients:**
The `lspace-mcp-server.js` script (in your `lspace-server` directory) is what MCP clients will execute. You need to tell your MCP client how to find and run this script.

**Important:** In the client configurations below, replace `/actual/absolute/path/to/your/lspace-server/` with the real absolute file path to the directory where you cloned and built the `lspace-server`.

1.  **Cursor:**
    Cursor can be configured via a JSON file. You can set this up per-project or globally:
    *   **Project Configuration**: Create a file at `.cursor/mcp.json` in your project's root directory.
    *   **Global Configuration**: Create a file at `~/.cursor/mcp.json` in your user home directory.

    Example `mcp.json` for Cursor:
    ```json
    {
      "mcpServers": {
        "lspace-knowledge-base": { // You can choose any name here
          "command": "node",
          "args": ["/actual/absolute/path/to/your/lspace-server/lspace-mcp-server.js"],
          "env": {
            // .env file in lspace-server directory should be picked up automatically.
            // Only add environment variables here if you need to override them
            // specifically for Cursor, or if the .env file is not found.
            // "OPENAI_API_KEY": "your_openai_key_if_not_in_lspace_env"
          }
        }
      }
    }
    ```
    *   Remember to replace the placeholder path in `args`.
    *   Restart Cursor after creating or modifying this configuration.

2.  **Claude Desktop:**
    Claude Desktop uses a central JSON configuration file:
    *   **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
    *   **Windows**: `%APPDATA%\\Claude\\claude_desktop_config.json`

    If this file doesn't exist, Claude Desktop might create it when you go to Settings > Developer > Edit Config.

    Example `claude_desktop_config.json` content:
    ```json
    {
      "mcpServers": {
        "lspace": { // You can choose any name here
          "command": "node",
          "args": ["/actual/absolute/path/to/your/lspace-server/lspace-mcp-server.js"]
          // "env": { ... } // Similar environment variable considerations as with Cursor
        }
      }
    }
    ```
    *   Ensure you replace the placeholder path in `args`.
    *   Restart Claude Desktop after saving changes to this file.

After configuring your MCP client, it should be able to start and communicate with your Lspace server, allowing you to use Lspace tools and access your configured knowledge bases from within the client.

## Understanding GitHub Personal Access Tokens (PATs) for Lspace

Lspace requires GitHub Personal Access Tokens (PATs) to interact with your GitHub repositories on your behalf. This includes operations like cloning repositories, reading content, and importantly, writing new content (e.g., generated knowledge base articles, processed raw inputs) by committing and pushing changes.

**Why PATs?**
PATs are a secure way to grant Lspace access to your GitHub account without needing your password. You can control the permissions (scopes) granted to each PAT and revoke them at any time.

**Creating a GitHub PAT for Lspace:**
1.  Go to your GitHub [Developer settings](https://github.com/settings/tokens).
2.  Click on "Personal access tokens" and then "Tokens (classic)". *For finer-grained control, you might explore "Fine-grained tokens", but "Tokens (classic)" are generally simpler for this type of application.*
3.  Click "Generate new token" (and then "Generate new token (classic)").
4.  Give your token a descriptive name, like "lspace-server-access".
5.  Set an expiration period for the token.
6.  **Select Scopes**: For Lspace to fully manage your repositories, including reading, writing, committing, and pushing, you **must select the `repo` scope**. This scope grants full control of public and private repositories.
    ![GitHub PAT repo scope](https://docs.github.com/assets/cb-33394/images/help/settings/token_scopes.png) *(Illustrative image link, actual UI may vary)*
7.  Click "Generate token".
8.  **Important**: Copy the generated token immediately. You will not be able to see it again. Store it securely.

**Using PATs in Lspace (`config.local.json`):**
In your `config.local.json` file, you'll define an `alias` for your PAT under the `credentials.github_pats` section and then reference this `pat_alias` in your GitHub repository configurations. See the "Managing Repositories Manually (`config.local.json`)" section for more details.

Example `credentials` block in `config.local.json`:
```json
{
  "credentials": {
    "github_pats": [
      {
        "alias": "my_lspace_pat",
        "token": "ghp_YOUR_COPIED_GITHUB_TOKEN_HERE"
      }
      // You can add more PATs with different aliases if needed
    ]
  },
  // ... rest of your repositories configuration ...
}
```

## Features

- **Self-hostable service** for git operations, search, and LLM integration.
- **Lspace MCP Server**: Implements the Model Context Protocol (MCP) via `lspace-mcp-server.js`, allowing AI agents and other tools to interact with Lspace capabilities programmatically. (See [modelcontextprotocol.io](https://modelcontextprotocol.io) for more on MCP).
- **Multi-repository management** with support for multiple git providers (local, GitHub).
- **AI Orchestration** for automated document classification, organization, and summarization.
- **Knowledge Base Generation** for creating a Wikipedia-like synthesis of repository content.
- **Dual-structure repositories** with raw documents and a synthesized knowledge base.
- **Timeline tracking** for document operations.
- **Extensible architecture** for custom integrations.

## Repository Structure

Lspace utilizes a dual-structure repository architecture:

1.  **Raw Document Storage (`/.lspace/raw_inputs/`)**:
    *   Original documents uploaded by users or ingested via the MCP server/API.
    *   AI-assisted categorization and organization.
    *   Metadata enhancement and structured formatting.
    *   Operations tracked in `/.lspace/timeline.json`.
2.  **Knowledge Base Synthesis (Repository Root)**:
    *   AI-generated, Wikipedia-like structure from raw documents.
    *   An entry page (typically `README.md` in the repository root) provides an overview.
    *   Topic pages synthesizing information across multiple documents.
    *   Cross-references and links back to source documents.

## Configuration Details

Beyond the Quick Start, here are more details on configuration:

### Lspace Configuration File (`config.local.json`)
This file is critical for defining repository connections (local paths, GitHub repo details) and credentials (like GitHub PATs).
See the "Managing Repositories Manually (`config.local.json`)" section for its structure.

### LLM Prompts Configuration
Prompts guiding the LLM for document processing and knowledge base generation are centralized in `src/config/prompts.ts`. Modify these to customize AI behavior.

## Running the Full API Server (Optional)

If you need the RESTful API endpoints (e.g., for web application integration or direct HTTP calls) in addition to or instead of the MCP server:

1.  Ensure your `.env` and `config.local.json` are set up as described above.
2.  Build the project: `npm run build`
3.  Run the development server:
    ```bash
    npm run dev
    ```
4.  Or, for a production deployment:
    ```bash
    npm start
    ```
These scripts typically start the full application defined in `src/index.ts`, which may include both REST API and MCP functionalities. The `lspace-mcp-server.js` script is a dedicated entry point optimized for MCP-only interactions.

## Managing Repositories Manually (`config.local.json`)

You can manage the repositories Lspace connects to by directly editing your local `config.local.json` file. This file is **not** committed to version control (it's in `.gitignore`). An example template, `config.example.json`, is provided in the repository.

**Always make your changes in `config.local.json`.**

The basic structure of the file includes a list of `credentials` (for services like GitHub) and a list of `repositories`.

```json
{
  "credentials": {
    "github_pats": [
      {
        "alias": "your_github_pat_alias",
        "token": "ghp_yourgithubpersonalaccesstoken"
      }
    ]
  },
  "repositories": [
    {
      "name": "My Local Project",
      "type": "local",
      "path": "/path/to/your/local/git/repository",
      "path_to_kb": ".",
      "id": "your_unique_id_for_this_repo"
    },
    {
      "name": "My Awesome GitHub Project",
      "type": "github",
      "owner": "your-github-username-or-org",
      "repo": "your-repository-name",
      "branch": "main",
      "pat_alias": "your_github_pat_alias",
      "path_to_kb": ".",
      "id": "another_unique_id"
    }
  ]
}
```

### Adding a Local Repository
1.  Ensure the repository is a valid Git repository.
2.  Add a new object to the `repositories` array in `config.local.json` (see example above).
    *   `name`: A human-readable name.
    *   `type`: Must be `"local"`.
    *   `path`: The absolute path to your local Git repository.
    *   `path_to_kb` (Optional): Relative path to the knowledge base root within the repo (e.g., `docs/kb`). Defaults to `.` (repository root).
    *   `id` (Optional): A unique UUID. If omitted, one will be generated.

### Adding a GitHub Repository
1.  Ensure you have a GitHub Personal Access Token (PAT) with `repo` scope.
2.  Add your PAT to the `credentials.github_pats` section (see example above).
3.  Add a new object to the `repositories` array (see example above).
    *   `name`, `type` (`"github"`), `owner`, `repo`, `branch`, `pat_alias`, `path_to_kb`, `id` as described.

After editing `config.local.json`, restart the Lspace MCP server or API server for changes to take effect. Lspace will then attempt to clone new GitHub repositories into the directory specified by `REPO_BASE_PATH` (or its default `cloned-github-repos`) and make all configured repositories available.

## License

This project is licensed under the Business Source License 1.1 (BSL 1.1).

This generally means:
*   You **can** freely use, modify, and self-host the software for personal projects, research, and internal non-commercial use.
*   Commercial use (e.g., offering a paid service using this software) is restricted and requires a separate commercial license from Robin Spottiswoode, or use of an official Lspace Cloud hosted service (if available).
*   After one (1) year from the public release date of each version, that version of the software will automatically convert to the Apache License 2.0, a permissive open-source license.

For the full license text, please see the `LICENSE` file in the repository.