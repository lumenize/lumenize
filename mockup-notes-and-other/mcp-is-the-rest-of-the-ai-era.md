# MCP is the REST API of the AI era

MCP-native could represent a transformative shift in how we think about APIs in the AI era. As AI becomes the primary consumer of APIs, the need for a standardized, AI-first interface is more critical than ever. MCP (Model Context Protocol) offers a vision for this future, and its adoption could redefine how services expose themselves to AI (and human) systems.

## The two MCP phases we've already seen

### 1. MCP-as-proxy (third-party agent approach)

Here, the MCP server acts as an intermediary, running locally or within a third-party environment. This model gave AIs immediate access to popular services—such as Gmail (via unofficial APIs and browser automation before Google offered official AI or plugin support), Twitter, Instagram, and Facebook Messenger—before those service providers could. However, it comes with limitations:

1. The proxy must keep up with changes to the underlying API and often exposes only a subset of capabilities.

2. Security is a major concern in this model. Third-party proxies often struggle to enforce proper access controls, which is the #1 risk in the OWASP API Security Top 10 ("Broken Object Level Authorization") and is echoed in several other top risks. These proxies can inadvertently expose sensitive data or allow unauthorized actions, making them a frequent target for attackers.

### 2. Vendor-supplied MCP access to existing APIs

In this model, the MCP server acts as a proxy to the vendor's existing APIs, exposing existing capabilities as MCP resources and tools. Unlike third-party proxies, these are provided by the same vendor and generally run in the same environment as the underlying systems. The subset of capabilities that the vendor offers up via MCP are then accessible for AI systems.

With this approach, the vendor has a better chance of addressing the access control risk, even though it has yet to be seen if they will.

Perhaps most importantly, just as language constrains thought, the way we expose our services will constrain how AI interacts with the world. What's good for a human consumer may not be optimal for an AI consumer.

I believe that this model serves as a stepping stone toward a future where MCP becomes the primary or even the sole API. By adopting this approach, SaaS vendors can reduce integration complexity, better position themselves in the AI ecosystem, and future-proof their offerings as AI becomes the dominant API consumer.

## The next phase: MCP as the primary API

The logical next step in this evolution is for MCP to move beyond being a proxy or alternative interface and become the primary—or even the sole—API that a service exposes. In this model, all capabilities and resources are surfaced through MCP, designed from the ground up for both AI and human consumers. This would eliminate the need for parallel REST or RPC APIs, reduce fragmentation, and create a unified, future-proof interface that is natively aligned with the needs of AI-driven applications and workflows.

### Why MCP-first APIs are better for AI (and humans)

MCP-first APIs are fundamentally better suited for AI—and, perhaps surprisingly, for humans as well. Here’s why:

- **Explicit schemas and semantic meaning:** MCP tools are designed for AI consumption from the ground up, with explicit schemas and semantic meaning that models can understand. This clarity reduces ambiguity for both machines and humans.
- **Robust error handling:** MCP's error model is tailored for AI interpretation, moving beyond simple HTTP status codes to provide actionable, structured feedback.
- **Standardized discovery:** Instead of relying on static API documentation, AI models can dynamically discover capabilities through MCP's tool listing.
- **Composable operations:** MCP tools enable more semantic operations (e.g., "create_customer_with_preferences") rather than basic CRUD actions (e.g., "POST /customers").

These same features that make MCP-first APIs ideal for AI also make them more consumable by humans than most existing REST APIs. Explicit schemas, discoverability, and semantic operations reduce ambiguity and cognitive load for human developers and integrators, not just for machines.

## This is already happening

While no vendor has fully transitioned to MCP-first APIs, we see early signs of this shift:

- **Salesforce's Agentforce**: Salesforce is integrating autonomous AI agents into its platform, hinting at a future where MCP-like interfaces could dominate.
- **Cloudflare's AI Agent Framework**: Cloudflare's tools for building and deploying AI agents align with the principles of MCP, emphasizing dynamic interaction and scalability.

These examples illustrate the growing momentum toward MCP-first designs, even if the transition is still in its infancy.

## The economic and technical incentives

For SaaS vendors, MCP-first APIs offer clear advantages:

- **Reduced integration complexity**: Simplifies the development of AI-powered applications.
- **Better ecosystem positioning**: Aligns with the needs of AI-first applications.
- **Standardized authentication and rate limiting**: Streamlines security and scalability.
- **Future-proofing**: Prepares for a world where AI is the primary API consumer.

Technically, MCP-first APIs provide:

- **Direct resource access**: Eliminates the need for translation layers.
- **Improved developer experience**: Simplifies API interactions for AI developers.

## A call to action

The shift to MCP-first APIs is not just a technical evolution; it's a strategic imperative. As AI continues to reshape industries, the need for standardized, AI-native interfaces will only grow. MCP offers a path forward, and early adopters stand to gain a significant competitive advantage.

The question is not whether MCP will become the "REST API of the AI era," but how quickly we can embrace this transformative shift.
