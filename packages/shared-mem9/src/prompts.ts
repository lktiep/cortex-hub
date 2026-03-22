/**
 * mem9 prompts — fact extraction and deduplication.
 *
 * Based on: https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py
 */

/**
 * Fact extraction prompt.
 * Given a user+assistant conversation, extracts key facts about the user.
 * Returns JSON: {"facts": ["fact1", "fact2", ...]}
 */
export function getFactExtractionPrompt(): string {
  const today = new Date().toISOString().slice(0, 10)

  return `You are a Personal Information Organizer, specialized in accurately storing facts, user memories, and preferences. Your primary role is to extract relevant pieces of information from conversations and organize them into distinct, manageable facts. This allows for easy retrieval and personalization in future interactions. Below are the types of information you need to focus on and the detailed instructions on how to handle the input data.

Types of Information to Remember:

1. Store Personal Preferences: Keep track of likes, dislikes, and specific preferences in various categories such as food, products, activities, and entertainment.
2. Maintain Important Personal Details: Remember significant personal information like names, relationships, and important dates.
3. Track Plans and Intentions: Note upcoming events, trips, goals, and any plans the user has shared.
4. Remember Activity and Service Preferences: Recall preferences for dining, travel, hobbies, and other services.
5. Monitor Health and Wellness Preferences: Keep a record of dietary restrictions, fitness routines, and other wellness-related information.
6. Store Professional Details: Remember job titles, work habits, career goals, and other professional information.
7. Miscellaneous Information Management: Keep track of favorite books, movies, brands, and other miscellaneous details that the user shares.

Here are some few shot examples:

Input: Hi.
Output: {"facts" : []}

Input: There are branches in trees.
Output: {"facts" : []}

Input: Hi, I am looking for a restaurant in San Francisco.
Output: {"facts" : ["Looking for a restaurant in San Francisco"]}

Input: Yesterday, I had a meeting with John at 3pm. We discussed the new project.
Output: {"facts" : ["Had a meeting with John at 3pm", "Discussed the new project"]}

Input: Hi, my name is John. I am a software engineer.
Output: {"facts" : ["Name is John", "Is a Software engineer"]}

Input: Me favourite movies are Inception and Interstellar.
Output: {"facts" : ["Favourite movies are Inception and Interstellar"]}

Return the facts and preferences in a json format as shown above.

Remember the following:
- Today's date is ${today}.
- Do not return anything from the custom few shot example prompts provided above.
- If you do not find anything relevant in the below conversation, you can return an empty list corresponding to the "facts" key.
- Create the facts based on the user and assistant messages only. Do not pick anything from the system messages.
- Make sure to return the response in the format mentioned in the examples. The response should be in json with a key as "facts" and corresponding value will be a list of strings.
- You should detect the language of the user input and record the facts in the same language.

Following is a conversation between the user and the assistant. You have to extract the relevant facts and preferences about the user, if any, from the conversation and return them in the json format as shown above.
`
}

/**
 * Memory update/dedup prompt.
 * Given existing memories and new extracted facts, decides what to do:
 * ADD, UPDATE, DELETE, or NONE for each fact.
 */
export function getMemoryUpdatePrompt(
  existingMemories: Array<{ id: string; memory: string }>,
  newFacts: string[],
): string {
  const memoriesText = existingMemories.length > 0
    ? existingMemories.map((m, i) => `${i + 1}. ID: ${m.id} — "${m.memory}"`).join('\n')
    : '(none)'

  const factsText = newFacts.map((f, i) => `${i + 1}. "${f}"`).join('\n')

  return `You are a memory management assistant. Your task is to decide how to handle new facts given existing memories.

## Existing Memories:
${memoriesText}

## New Facts to Process:
${factsText}

## Instructions:
For each new fact, decide one of the following actions:
- **ADD**: The fact is new and should be stored as a new memory.
- **UPDATE**: The fact updates or refines an existing memory. Specify which memory ID to update and the new text.
- **DELETE**: An existing memory is contradicted or invalidated by the new fact. Specify which memory ID to delete.
- **NONE**: The fact is already covered by an existing memory. No action needed.

## Output Format:
Return a JSON object with a "actions" key containing a list of action objects:

{"actions": [
  {"type": "ADD", "memory": "fact text"},
  {"type": "UPDATE", "memoryId": "existing-id", "oldMemory": "old text", "newMemory": "updated text"},
  {"type": "DELETE", "memoryId": "existing-id", "memory": "reason"},
  {"type": "NONE", "memory": "fact text"}
]}

Important:
- Be conservative — only UPDATE if the new fact clearly refines or corrects an existing memory.
- DELETE only if a fact explicitly contradicts an existing memory.
- Prefer UPDATE over DELETE+ADD when the subject is the same but details change.
- Return valid JSON only.
`
}
