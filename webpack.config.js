let path = require("path");
let HtmlWebpackPlugin = require("html-webpack-plugin")
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');
const ExtractTextPlugin = require('extract-text-webpack-plugin');
module.exports = {
    mode: "development",
    entry: "./src/index.js",
    output: {
        filename: "index.js",   //
        path: path.resolve(__dirname, "build")
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: './public/index.html',
            filename: 'index.html',
            minify: {
                removeAttributeQuotes: true,
                collapseWhitespace: true
            },
            hash: true
        }),

        new MonacoWebpackPlugin(),
        

    ],
    module: {       // 配置 webpack 使用到的模块
        rules: [
            {
                test: /\.css$/,     // 针对 .css 结尾的文件，使用下面的loader进行处理
                use: [
                    'style-loader',
                    'css-loader'
                ]
            }
        ]
            
        
    }
}
