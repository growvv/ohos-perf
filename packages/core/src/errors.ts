export class OhosPerfError extends Error {
  readonly code?: string;
  constructor(message: string, opts: { cause?: unknown; code?: string } = {}) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.code = opts.code;
  }
}

export class HdcNotFoundError extends OhosPerfError {
  readonly searchedPaths: string[];
  constructor(
    searchedPaths: string[],
    opts: { cause?: unknown; code?: string } = {},
  ) {
    super(
      `hdc executable not found. Searched paths: ${searchedPaths.join(', ')}`,
      opts,
    );
    this.searchedPaths = searchedPaths;
  }
}

export class DeviceNotFoundError extends OhosPerfError {
  readonly targetsOutput: string;
  constructor(
    targetsOutput: string,
    opts: { cause?: unknown; code?: string } = {},
  ) {
    super(
      `No HarmonyOS device found. \`hdc list targets\` output: ${targetsOutput}`,
      opts,
    );
    this.targetsOutput = targetsOutput;
  }
}

export class StreamerNotFoundError extends OhosPerfError {
  readonly searchedPaths: string[];
  constructor(
    searchedPaths: string[],
    opts: { cause?: unknown; code?: string } = {},
  ) {
    super(
      `streamer executable not found. Searched paths: ${searchedPaths.join(', ')}`,
      opts,
    );
    this.searchedPaths = searchedPaths;
  }
}

export class IngestError extends OhosPerfError {
  readonly stderr: string;
  constructor(
    message: string,
    stderr: string,
    code?: string,
    opts: { cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause, code });
    this.stderr = stderr;
  }
}
