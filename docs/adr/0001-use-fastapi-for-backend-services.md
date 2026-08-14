# ADR-0001: FastAPI Framework Selection

> ⚠ **NOT IMPLEMENTED.** This decision was never carried out. The backend is Node.js +
> Express (`finchat/legacy_prototype/backend`). The FastAPI attempt was abandoned and
> now sits dead in `finchat/_ARCHIVED_api/`. Retained as a historical record of the
> reasoning; do not treat it as describing the current stack. See
> [CURRENT_ARCHITECTURE.md](../CURRENT_ARCHITECTURE.md).

- **Status**: Superseded — decision reversed in practice, never implemented
- **Date**: 2026-07-03
- **Deciders**: Platform Architecture Team
- **Technical Domain**: Backend Services

## Context and Problem Statement
The FinChat platform requires a high-performance, asynchronous backend framework to serve as the API gateway and orchestrate real-time messages, multi-agent activities, and long-running AI generation tasks. 

Our prototype was built using Node.js/Express, but as we transition to a platform-level architecture with deep AI integration, complex orchestration pipelines, and advanced security constraints, we must evaluate our long-term framework choice. We need to decide whether to continue with Node.js/Express, adopt a heavy Python framework like Django, or migrate to a modern, lightweight Python framework like FastAPI.

## Decision Drivers
- **Asynchronous Concurrency**: The orchestrator must handle thousands of concurrent WebSocket/SSE connections and background agent tasks without blocking.
- **AI/ML Integration**: Deep integration with local models (Ollama, HuggingFace) and cloud APIs (OpenAI, Anthropic, Gemini) which are primarily supported by Python-native libraries.
- **Development Speed & Developer Experience**: Auto-generated API documentation (OpenAPI/Swagger), native data validation, and strong typing.
- **Performance**: High request throughput and low overhead/latency.

## Considered Options
1. **Node.js / Express**: Keep the prototype stack. High concurrency, but lacks native Python AI/ML library ecosystem.
2. **Python / Django**: Mature, full-featured Python framework. Built-in admin panel, ORM, and middleware. However, it is synchronous by default, has high overhead, and async support feels bolted-on.
3. **Python / FastAPI**: Modern, fast (high-performance), ASGI-based Python framework. Native support for `async/await`, Pydantic validation, and automatic OpenAPI generation.

## Decision Outcome
Chosen Option: **FastAPI**, because it perfectly bridges the high-performance asynchronous concurrency requirements with Python's industry-standard AI/ML ecosystem.

### Consequences
- **Positive**:
  - **Async Support**: Native, first-class support for asynchronous requests, making websocket management and non-blocking background worker processes highly efficient.
  - **Data Safety**: Pydantic models validate incoming requests and outgoing responses at runtime, reducing bugs and ensuring clean contracts between the React frontend and backend.
  - **Interactive API Docs**: Automatic Swagger/ReDoc generation simplifies API client development and frontend integration.
  - **AI Alignment**: Native Python allows direct integration with LangChain, LlamaIndex, PyTorch, and Ollama libraries, eliminating language boundaries in orchestration.
- **Negative**:
  - **Ecosystem Shift**: Moving from Node.js/Express to Python/FastAPI requires rewriting the prototype's routes and middlewares (e.g. auth, db access).
  - **No Out-of-the-Box Admin Panel**: Unlike Django, FastAPI does not include a pre-built admin panel, requiring manual implementation or integrating third-party admin packages (e.g., SQLAdmin).
- **Risks**:
  - Developers familiar with JS/Node need to ramp up on Python's async event loop mechanics (`uvicorn` / `gunicorn` management).
