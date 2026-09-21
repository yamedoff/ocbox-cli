#!/bin/bash
set -euo pipefail

umask 027
cd /workspace
exec "$@"
