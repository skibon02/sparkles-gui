{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    sparkles = {
      url = "github:skibon02/sparkles/main";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, sparkles }:
  let
    supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
    forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
  in {
    packages = forAllSystems (system:
    let
      pkgs = nixpkgs.legacyPackages.${system};

      frontend = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "sparkles-gui-frontend";
        version = "0.0.0";
        src = ./frontend;

        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.pnpm_9
          pkgs.pnpmConfigHook
        ];

        pnpmDeps = pkgs.fetchPnpmDeps {
          inherit (finalAttrs) pname version src;
          pnpm = pkgs.pnpm_9;
          hash = "sha256-UoxlBDjqoKNz/sCIMkx6zHfwxAJsh3eA7E6V8sIWaFo=";
          fetcherVersion = 3;
        };

        buildPhase = ''
          runHook preBuild
          pnpm build
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          cp -r dist $out
          runHook postInstall
        '';
      });

    in {
      inherit frontend;

      sparkles-gui = pkgs.rustPlatform.buildRustPackage {
        pname = "sparkles-gui";
        version = "0.1.0";
        src = ./.;

        cargoLock.lockFile = ./Cargo.lock;

        nativeBuildInputs = [ pkgs.makeWrapper ];

        postPatch = ''
          # Replace patched deps with direct path deps pointing to the nix store
          substituteInPlace Cargo.toml \
            --replace-fail 'sparkles-parser = { version = "0.2.0" }' 'sparkles-parser = { path = "${sparkles}/sparkles-parser" }' \
            --replace-fail 'sparkles = { version ="0.2.0", optional = true }' 'sparkles = { path = "${sparkles}/sparkles", optional = true }'

          # Remove [patch.crates-io] section — no longer needed with direct path deps
          sed -i '/^\[patch\.crates-io\]/,/^$/d' Cargo.toml
        '';

        postInstall = ''
          mkdir -p $out/lib/sparkles-gui/frontend
          cp -r ${frontend} $out/lib/sparkles-gui/frontend/dist
          mv $out/bin/sparkles-gui $out/lib/sparkles-gui/sparkles-gui
          makeWrapper $out/lib/sparkles-gui/sparkles-gui $out/bin/sparkles-gui \
            --chdir $out/lib/sparkles-gui
        '';
      };

      default = self.packages.${system}.sparkles-gui;
    });
  };
}
