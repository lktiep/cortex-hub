/**
 * Give the memory collection its lexical arm.
 *
 * A memory collection created before hybrid search holds dense vectors only,
 * and Qdrant cannot add a sparse vector to a collection that exists. This copies
 * it into one that has both — reusing the stored embeddings, so nothing is
 * re-embedded — then puts the copy behind the old name as an alias, so no caller
 * has to change.
 *
 *   docker exec cortex-api node apps/dashboard-api/dist/scripts/migrate-memories.js           # report only
 *   docker exec cortex-api node apps/dashboard-api/dist/scripts/migrate-memories.js --apply   # copy, snapshot, switch
 *
 * Restart cortex-api afterwards: a running server decided at start-up that the
 * collection had no lexical arm, and keeps searching by vector alone until then.
 */

import { describeCollection, switchToHybridCollection, SPARSE_VECTOR_NAME } from '@cortex/shared-mem9'
import { MEMORY_COLLECTION, memoryQdrantUrl } from '../lib/memory-collection.js'

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const source = option('--collection') ?? MEMORY_COLLECTION
  const target = option('--target') ?? `${source}_hybrid`
  const qdrantUrl = memoryQdrantUrl()

  const current = await describeCollection(qdrantUrl, source)
  if (!current) {
    console.log(`${source} does not exist yet. The first memory stored creates it with both arms.`)
    return
  }
  if (current.sparseVectorNames.includes(SPARSE_VECTOR_NAME)) {
    const via = current.isAlias ? ` (an alias of ${current.collection})` : ''
    console.log(`${source}${via} already has the lexical arm. Nothing to do.`)
    return
  }

  const earlier = await describeCollection(qdrantUrl, target)
  console.log(`${source}: ${current.points} memories, ${current.vectorSize}-dim ${current.distance}, vector search only.`)
  console.log(
    earlier
      ? `${target}: exists from an earlier run with ${earlier.points} points; it is brought up to date, not recreated.`
      : `${target}: will be created with a dense and a lexical arm.`,
  )

  if (!apply) {
    console.log(
      `\nDry run. --apply copies every memory into ${target}, snapshots ${source}, ` +
        `checks the copy once more, deletes ${source} and makes that name an alias of ${target}.`,
    )
    return
  }

  const report = await switchToHybridCollection({ qdrantUrl, source, target })
  console.log(
    `\nCopied ${report.points} memories into ${target} ` +
      `(${report.copied} writes, ${report.removed} removed, mean length ${report.averageLength.toFixed(1)} tokens).`,
  )
  // Qdrant writes snapshots under /qdrant/snapshots, which the stock compose file
  // does not mount: recreating the container would take the rollback with it.
  console.log(`Snapshot of the original: /qdrant/snapshots/${source}/${report.snapshot} inside the Qdrant container.`)
  console.log(`  Keep a copy outside it: docker cp <qdrant container>:/qdrant/snapshots/${source}/${report.snapshot} .`)
  console.log(`${source} is now an alias of ${target}. Restart cortex-api to search with both arms.`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
