<!-- Generated from results/bench-output.json on 2026-05-16T13:27:37.480Z -->
<!-- Node v22.22.0, perf mean of 5 runs -->

### Snapshot size at N=100

| Format | Raw | Gzipped | vs tuple (raw) | vs tuple (gz) |
|---|---:|---:|---:|---:|
| tuple | 15.0KB | 1.8KB | +0.0% | +0.0% |
| W1 | 15.5KB | 2.1KB | +3.8% | +18.2% |
| W2 | 17.3KB | 2.1KB | +15.8% | +20.7% |
| W3 | 9.6KB | 1.8KB | -36.1% | +4.2% |
| W4 | 7.6KB | 1.3KB | -48.9% | -26.1% |

### Snapshot size at N=1000

| Format | Raw | Gzipped | vs tuple (raw) | vs tuple (gz) |
|---|---:|---:|---:|---:|
| tuple | 153.3KB | 17.1KB | +0.0% | +0.0% |
| W1 | 159.8KB | 20.2KB | +4.2% | +18.3% |
| W2 | 177.2KB | 20.5KB | +15.6% | +20.1% |
| W3 | 100.9KB | 18.5KB | -34.2% | +8.0% |
| W4 | 80.3KB | 13.0KB | -47.6% | -23.9% |

### Snapshot size at N=10000

| Format | Raw | Gzipped | vs tuple (raw) | vs tuple (gz) |
|---|---:|---:|---:|---:|
| tuple | 1.56MB | 164.5KB | +0.0% | +0.0% |
| W1 | 1.63MB | 192.4KB | +4.7% | +17.0% |
| W2 | 1.80MB | 195.6KB | +15.6% | +18.9% |
| W3 | 1.06MB | 183.9KB | -32.2% | +11.8% |
| W4 | 853.8KB | 129.1KB | -46.5% | -21.5% |

### Patch size at N=100 (gzipped)

| Format | add-leaf | rename-label | move-single | move-subtree-50 | grant-permission |
|---|---:|---:|---:|---:|---:|
| tuple | 1.8KB | 1.7KB | 1.7KB | 1.7KB | 1.7KB |
| W1 | 1.2KB | 112B | 426B | 428B | 149B |
| W2 | 1.1KB | 77B | 81B | 80B | 110B |
| W3 | 943B | 59B | 62B | 61B | 79B |
| W4 | 106B | 62B | 61B | 60B | 67B |

### Patch size at N=1000 (gzipped)

| Format | add-leaf | rename-label | move-single | move-subtree-50 | grant-permission |
|---|---:|---:|---:|---:|---:|
| tuple | 17.1KB | 17.0KB | 17.0KB | 17.0KB | 22B |
| W1 | 10.9KB | 114B | 4.2KB | 4.2KB | 22B |
| W2 | 10.0KB | 79B | 87B | 85B | 22B |
| W3 | 9.3KB | 61B | 68B | 66B | 22B |
| W4 | 109B | 63B | 66B | 64B | 22B |

### Patch size at N=10000 (gzipped)

| Format | add-leaf | rename-label | move-single | move-subtree-50 | grant-permission |
|---|---:|---:|---:|---:|---:|
| tuple | 164.5KB | 164.5KB | 164.4KB | 164.4KB | 164.4KB |
| W1 | 111.0KB | 117B | 47.5KB | 47.5KB | 89B |
| W2 | 112.3KB | 81B | 90B | 89B | 76B |
| W3 | 108.4KB | 63B | 71B | 70B | 58B |
| W4 | 113B | 64B | 68B | 67B | 69B |

### Encode / decode / patch perf at N=10000 (ms, mean over 5 runs)

| Format | Operation | Encode | Decode | Diff | Apply |
|---|---|---:|---:|---:|---:|
| tuple | add-leaf | 4.2 | 3.1 | 4.3 | 4.8 |
| tuple | rename-label | 4.1 | 3.1 | 6.9 | 4.1 |
| tuple | move-single | 4.1 | 3.1 | 11.4 | 4.0 |
| tuple | move-subtree-50 | 4.2 | 2.9 | 11.6 | 4.1 |
| tuple | grant-permission | 3.8 | 3.2 | 12.7 | 4.2 |
| W1 | add-leaf | 4.7 | 3.4 | 7.0 | 3.9 |
| W1 | rename-label | 4.5 | 3.4 | 9.7 | 1.0 |
| W1 | move-single | 4.3 | 3.3 | 18.0 | 2.2 |
| W1 | move-subtree-50 | 7.7 | 3.5 | 17.6 | 2.2 |
| W1 | grant-permission | 4.4 | 3.3 | 17.3 | 1.0 |
| W2 | add-leaf | 3.9 | 3.0 | 16.6 | 7.7 |
| W2 | rename-label | 4.1 | 2.9 | 10.3 | 1.0 |
| W2 | move-single | 4.1 | 3.3 | 24.1 | 2.6 |
| W2 | move-subtree-50 | 4.3 | 3.3 | 22.8 | 2.7 |
| W2 | grant-permission | 4.3 | 3.1 | 19.5 | 1.0 |
| W3 | add-leaf | 4.1 | 3.1 | 11.0 | 7.4 |
| W3 | rename-label | 4.0 | 3.1 | 9.2 | 1.0 |
| W3 | move-single | 3.9 | 3.2 | 17.4 | 2.6 |
| W3 | move-subtree-50 | 4.2 | 3.1 | 17.3 | 2.6 |
| W3 | grant-permission | 3.8 | 3.1 | 15.7 | 1.0 |
| W4 | add-leaf | 6.2 | 5.8 | 11.0 | 3.2 |
| W4 | rename-label | 6.1 | 5.7 | 8.3 | 1.5 |
| W4 | move-single | 6.1 | 6.0 | 15.2 | 1.6 |
| W4 | move-subtree-50 | 6.2 | 6.6 | 15.2 | 1.6 |
| W4 | grant-permission | 5.9 | 7.1 | 13.0 | 0.1 |
