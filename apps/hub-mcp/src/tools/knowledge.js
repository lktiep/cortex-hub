import { z } from 'zod';
/**
 * Register knowledge tools.
 * Proxies to Qdrant REST API for retrieving document snippets/knowledge.
 */
export function registerKnowledgeTools(server, env) {
    // knowledge.search — search vector db for related concepts
    server.tool('cortex.knowledge.search', 'Search the platform knowledge base by semantic similarity using Qdrant. Returns relevant snippets and document text.', {
        query_vector: z.array(z.number()).describe('The text embedding vector (dense) for the search query'),
        collection_name: z.string().optional().describe('Qdrant collection to search (default: "knowledge")'),
        limit: z.number().optional().describe('Maximum number of results to return (default: 5)'),
    }, async ({ query_vector, collection_name, limit }) => {
        const collection = collection_name ?? 'knowledge';
        try {
            const response = await fetch(`${env.QDRANT_URL}/collections/${collection}/points/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    vector: query_vector,
                    limit: limit ?? 5,
                    with_payload: true,
                }),
                signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) {
                const errorText = await response.text();
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Knowledge search failed: ${response.status} ${errorText}`,
                        },
                    ],
                    isError: true,
                };
            }
            const data = await response.json();
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            collection,
                            results: data.result || [],
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Knowledge search error: ${error instanceof Error ? error.message : 'Unknown'}`,
                    },
                ],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=knowledge.js.map