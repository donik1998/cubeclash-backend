import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Length } from 'class-validator';

import { INVITE_CODE_LENGTH } from '../invite-code';

/**
 * `POST /races/join` body — spec §8.
 *
 * The code is upper-cased before validation so `abc123` and `ABC123` resolve the
 * same room: codes are generated from an upper-case alphabet, and a human typing
 * one from a screenshot should not be punished for their keyboard's shift state.
 * This is the one field the contract lets us normalise — unlike `scramble`,
 * where every byte is load-bearing.
 */
export class JoinRaceDto {
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Length(INVITE_CODE_LENGTH, INVITE_CODE_LENGTH)
  code!: string;
}
