// Force-included (-include) into every recorded program. stdout is a file
// while recording, and each step reports how much of it has been written, so
// output must reach the file the moment it is printed:
//  - stdio is made unbuffered, which also covers std::cout while it goes
//    through stdio (sync_with_stdio on, the default);
//  - std::cout, cerr and clog get unitbuf, flushing after every <<. That flag
//    belongs to the stream, not its buffer, so it survives
//    ios::sync_with_stdio(false), which competitive programs call first and
//    which gives cout a private buffer of its own.
#include <cstdio>
#include <iostream>

namespace {
struct VoidRunUnbufferedStdout {
    VoidRunUnbufferedStdout() {
        std::setvbuf(stdout, nullptr, _IONBF, 0);
        std::cout.setf(std::ios::unitbuf);
        std::cerr.setf(std::ios::unitbuf);
        std::clog.setf(std::ios::unitbuf);
    }
} voidrun_unbuffered_stdout_;
}  // namespace
