{
  description = "kubedash: mobile-first dashboard for homelab Kubernetes workloads";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }: let
    systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    eachSystem = nixpkgs.lib.genAttrs systems;
    forSystem = system: let
      pkgs = import nixpkgs { inherit system; };
      frontend = pkgs.buildNpmPackage {
        pname = "kubedash-ui"; version = "0.1.0";
        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter = path: type: !(builtins.elem (baseNameOf path) [ "node_modules" "target" "dist" ".git" "backend" ".github" "deploy" "result" "scripts" "README.md" "flake.nix" "flake.lock" ]);
        };
        nodejs = pkgs.nodejs_26;
        # Read from package-lock.json, so dependency updates need no hash bump.
        npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
        npmConfigHook = pkgs.importNpmLock.npmConfigHook;
        installPhase = ''mkdir -p $out/share/kubedash; cp -r dist/. $out/share/kubedash/'';
      };
      backend = pkgs.rustPlatform.buildRustPackage {
        pname = "kubedash"; version = "0.1.0";
        src = pkgs.lib.cleanSourceWith { src = ./backend; filter = path: type: baseNameOf path != "target"; };
        cargoLock.lockFile = ./backend/Cargo.lock;
      };
    in { inherit pkgs frontend backend; };
  in {
    packages = eachSystem (system: let build = forSystem system; inherit (build) pkgs frontend backend; in {
      inherit frontend backend;
      default = backend;
    } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
      container = pkgs.dockerTools.buildLayeredImage {
        name = "ghcr.io/fruitiex/kubedash"; tag = "main";
        contents = [ backend frontend pkgs.cacert pkgs.tzdata ];
        extraCommands = ''mkdir -p tmp; chmod 1777 tmp'';
        config = {
          User = "10001:10001"; WorkingDir = "/";
          Entrypoint = [ "${backend}/bin/kubedash" ];
          Env = [ "KUBEDASH_BIND=0.0.0.0:8080" "KUBEDASH_STATIC_DIR=${frontend}/share/kubedash" "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" "TZDIR=${pkgs.tzdata}/share/zoneinfo" ];
          ExposedPorts."8080/tcp" = {};
        };
      };
    });
    devShells = eachSystem (system: let pkgs = (forSystem system).pkgs; in {
      default = pkgs.mkShell {
        packages = with pkgs; [ nodejs_26 cargo rustc rustfmt clippy rust-analyzer pkg-config gcc git kubectl chromium ];
        shellHook = ''export PLAYWRIGHT_CHROMIUM_EXECUTABLE=${pkgs.chromium}/bin/chromium; echo "kubedash: npm run dev | cargo run --manifest-path backend/Cargo.toml"'';
      };
    });
  };
}
