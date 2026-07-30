import { Module } from '@nestjs/common';

/**
 * Server-side scramble generation.

 * Random-move for the MVP; WCA random-state later. Where the server cannot
 * generate a legal scramble it returns an empty list — it never substitutes one
 * puzzle's notation for another, because a wrong scramble that *looks* right is
 * worse than an honest gap.
 *
 * Endpoints: GET /scramble
 *
 * Not implemented yet — registered so the module graph matches the documented
 * architecture from the first commit.
 */
@Module({})
export class ScrambleModule {}
