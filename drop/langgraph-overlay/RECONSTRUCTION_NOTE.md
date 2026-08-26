# Reconstruction note

The original `sandbox:/mnt/data/nanobrowser-langgraph-modernization.zip` was stored in transient execution storage and expired before it was retained as a conversation attachment.

This ZIP was rebuilt from the retained implementation/research context against the same Nano Browser baseline commit (`24a14b76e14a9c30fd84878ca7985049d1e7d064`). It reproduces the LangGraph executor design, tests, modernized LangChain dependency pins, and upgrade guide.

It is **not byte-for-byte identical** to the expired archive. In particular, the original transient lockfile/build logs cannot be recovered. Apply this overlay to a clean checkout, regenerate `pnpm-lock.yaml`, and run the included validation script.
