#!/usr/bin/env python3
import os
import re

def main():
    base_dir = os.path.join(os.path.dirname(__file__), '..')
    sw_path = os.path.join(base_dir, 'sw.js')
    if not os.path.exists(sw_path):
        print(f"Error: sw.js not found at {sw_path}")
        exit(1)

    sha = os.environ.get('CF_PAGES_COMMIT_SHA')
    if not sha:
        import hashlib
        import time
        sha = hashlib.sha1(str(time.time()).encode()).hexdigest()

    short_sha = sha[:7]
    version = f"hc-{short_sha}"

    with open(sw_path, 'r') as f:
        content = f.read()

    new_content = re.sub(r"const VERSION = '[^']+';", f"const VERSION = '{version}';", content)
    with open(sw_path, 'w') as f:
        f.write(new_content)

    print(f"Stamped sw.js with version {version}")

    index_path = os.path.join(base_dir, 'index.html')
    if os.path.exists(index_path):
        with open(index_path, 'r') as f:
            idx_content = f.read()
        
        idx_content = re.sub(r'<span id="app-version">[^<]+</span>', f'<span id="app-version">{short_sha}</span>', idx_content)
        with open(index_path, 'w') as f:
            f.write(idx_content)
        print(f"Stamped index.html with version {short_sha}")

if __name__ == '__main__':
    main()
