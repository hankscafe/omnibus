fn main() {
    // We only need to tell the compiler to link this specific C++ library on Windows
    #[cfg(target_os = "windows")]
    {
        println!("cargo:rustc-link-lib=advapi32");
    }
}