# Third-party notices

The MIT License in this repository covers original project source written for
DrawbackEngine. It does not replace the licenses or terms of dependencies,
external chess engines, websites, community posts, rule names, or factual
compatibility observations.

## Runtime libraries

- [chess.js](https://github.com/jhlywa/chess.js), version 1.4.0, is used under
  the BSD 2-Clause License.
- [chessops](https://github.com/niklasf/chessops), version 0.15.1, is used under
  the GNU General Public License, version 3 or later. Distributions that combine
  this project with chessops must comply with that license.
- [React](https://github.com/facebook/react) and React DOM, version 19, are
  used under the MIT License for the local play interface.
- [react-chessboard](https://github.com/Clariity/react-chessboard), version
  5.10.0, is used under the MIT License for board rendering and interaction.
- [Vite](https://github.com/vitejs/vite), version 6, is used under the MIT
  License to build the local play interface.

Dependency source is installed by pnpm and is not copied into this repository.
The lockfile records the exact dependency graph used by local builds and CI.

## External UCI engines

DrawbackEngine can communicate with:

- [Stockfish](https://github.com/official-stockfish/Stockfish), licensed under
  GNU GPL version 3;
- [Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish),
  licensed under GNU GPL version 3.

No Stockfish or Fairy-Stockfish binary, network, or source tree is included.
Users provide their own executable and are responsible for its license. The
checked-in `data/catalog/drawbackchess-fairy-v1.ini` file is original project
configuration; it does not contain Fairy-Stockfish code.

## Drawback names and public research

The machine-readable catalogs record drawback names, short descriptions, and
compatibility observations collected from public sources, including:

- [drawbackchess.com](https://www.drawbackchess.com/);
- the Chess.com community thread
  [all drawbacks](https://www.chess.com/forum/view/general/all-drawbacks);
- [InvalidSE/DrawbackDetector](https://github.com/InvalidSE/DrawbackDetector)
  at the source revisions recorded in the catalog.

These records are provenance and interoperability research. DrawbackEngine is
not affiliated with or endorsed by those sites or authors. Their names,
descriptions, posts, brands, and other third-party content are not relicensed
under MIT by this repository.

No third-party engine implementation code was copied into DrawbackEngine.
