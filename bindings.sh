#!/bin/bash

bindings=""

# Function to extract variable names from the TypeScript interface
extract_env_vars() {
  # Declaration lines only (`  NAME: type;`). Names may contain DIGITS and lowercase (S3_BUCKET,
  # HuggingFace_API_KEY) — the old `[A-Z_]\+:` matched `_BUCKET`, so every S3_* variable was silently
  # dropped in production. `env-delivery.spec.ts` runs this exact pattern.
  grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*:' worker-configuration.d.ts | tr -d ' \t:'
}

# First try to read from .env.local if it exists
if [ -f ".env.local" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ ! "$line" =~ ^# ]] && [[ -n "$line" ]]; then
      name=$(echo "$line" | cut -d '=' -f 1)
      value=$(echo "$line" | cut -d '=' -f 2-)
      value=$(echo $value | sed 's/^"\(.*\)"$/\1/')
      bindings+="--binding ${name}=${value} "
    fi
  done < .env.local
else
  # If .env.local doesn't exist, use environment variables defined in .d.ts
  env_vars=($(extract_env_vars))
  # Generate bindings for each environment variable if it exists
  for var in "${env_vars[@]}"; do
    if [ -n "${!var}" ]; then
      bindings+="--binding ${var}=${!var} "
    fi
  done
fi

bindings=$(echo $bindings | sed 's/[[:space:]]*$//')

echo $bindings