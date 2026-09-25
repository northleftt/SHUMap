# Legacy contract fixture

`legacy/*.ts` is copied from `fdd7931^1` (the parent of the floor-image PR merge). Only relative runtime import paths in manifestContract.ts are changed for bundling. Keep frozen: it represents an already-shipped strict parser, not a second implementation to maintain. The actual WeChat production package commit must still be confirmed against release records.
