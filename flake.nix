{
  description = "codemirror-vim development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_22
            yarn
            chromium
            chromedriver
            # neovim
          ];

          shellHook = ''
            export CHROME_BIN="${pkgs.chromium}/bin/chromium"
            export CHROMEDRIVER_BIN="${pkgs.chromedriver}/bin/chromedriver"
            export SE_CHROMEDRIVER="${pkgs.chromedriver}/bin/chromedriver"
          '';
        };
      }
    );
}
