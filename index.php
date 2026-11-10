<?php
// Optional PHP entry point for PHP hosting.
// Railway Node.js deployment uses server.js and index.html instead.
$index = __DIR__ . '/index.html';
if (is_file($index)) {
    readfile($index);
} else {
    http_response_code(404);
    echo 'CineWave homepage not found. Make sure index.html is beside index.php.';
}
?>
