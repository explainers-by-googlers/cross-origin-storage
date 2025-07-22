async function requestFileHandles(hashes, create = false) {
  console.log(hashes, create);
}

const crossOriginStorage = {
  requestFileHandles: async (hashes, options = {}) => {
    if (!hashes) {
      throw new TypeError(
        `Failed to execute 'requestFileHandles': first argument 'hashes' is required.`,
      );
    }
    if (!Array.isArray(hashes)) {
      throw new TypeError(
        `Failed to execute 'requestFileHandles': first argument 'hashes' must be an array.`,
      );
    }
    for (const hash of hashes) {
      if (!hash.value) {
        throw new TypeError(
          `Failed to execute 'requestFileHandles': missing required 'hash.value'.`,
        );
      }
      if (!hash.algorithm) {
        throw new TypeError(
          `Failed to execute 'requestFileHandles': missing required 'hash.algorithm'.`,
        );
      }
    }
    const { create = false } = options;
    return await requestFileHandles(hashes, create).catch((err) => {
      throw err;
    });
  },
};

if (!navigator.crossOriginStorage) {
  Object.defineProperty(navigator, 'crossOriginStorage', {
    value: crossOriginStorage,
    writable: false,
  });
}
