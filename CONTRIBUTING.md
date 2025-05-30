# Contributing to Bee Context API

First off, thank you for considering contributing to the Bee Context API! Your help is essential for keeping it great.

## How Can I Contribute?

### Reporting Bugs
- Ensure the bug was not already reported by searching on GitHub under [Issues](https://github.com/robin-blocks/lspace-server/issues).
- If you're unable to find an open issue addressing the problem, [open a new one](https://github.com/robin-blocks/lspace-server/issues/new). Be sure to include a **title and clear description**, as much relevant information as possible, and a **code sample or an executable test case** demonstrating the expected behavior that is not occurring.

### Suggesting Enhancements
- Open a new issue to explain your enhancement suggestion. Provide as much detail and context as possible.

### Code Contributions
We welcome pull requests.

1.  **Fork the repository** and create your branch from `main`.
2.  **Set up your development environment** by following the Quick Start guide in the `README.md`.
3.  **Make your changes.**
    *   Try to follow the existing code style.
    *   Add tests for any new code you write.
    *   Ensure all tests pass (`npm test` and relevant `npm run test:e2e` if applicable).
4.  **Commit your changes.**
    *   Please try to write clear, concise commit messages. (Consider [Conventional Commits](https://www.conventionalcommits.org/) if you're familiar with it, but it's not strictly required).
5.  **Open a Pull Request** to the `main` branch of the `robin-blocks/lspace-server` repository.
    *   Provide a clear description of the problem and solution. Include the relevant issue number if applicable.

## Coding Standards
- Follow the existing code style. We use Prettier for code formatting (you can run `npm run format`).
- Ensure ESLint passes (`npm run lint`).

## Testing
- Include tests when you contribute new features, as they help to a) prove that your code works correctly, and b) guard against future breaking changes.
- Run `npm test` for unit/integration tests.
- For features impacting core AI orchestration or knowledge base generation, consider if an E2E test (see `README.md` testing section and `npm run test:e2e`) is appropriate.

## Code of Conduct
Please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms. We expect everyone to follow the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Please report unacceptable behavior to robin@theforever.io.

## Licensing
By contributing, you agree that your contributions will be licensed under the terms of the project's license (Business Source License 1.1, converting to Apache License 2.0).

---

We look forward to your contributions! 