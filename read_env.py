import os
import re

Import("env")

# Find .env in project directory
proj_dir = env.get("PROJECT_DIR")
env_file = os.path.join(proj_dir, ".env")

if os.path.exists(env_file):
    print(f"[{env.get('PIOTOOL', 'PIO')}] Loading variables from {env_file}...")
    with open(env_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            # Skip comments and empty lines
            if not line or line.startswith("#"):
                continue
            # Split key and value
            parts = line.split("=", 1)
            if len(parts) == 2:
                key = parts[0].strip()
                val = parts[1].strip()
                # Strip quotes
                if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                    val = val[1:-1]
                # Add as string macro
                env.Append(BUILD_FLAGS=[f'-D {key}=\\\"{val}\\\"'])
else:
    print(f"[{env.get('PIOTOOL', 'PIO')}] .env file not found at {env_file}. Using build flags defaults.")
